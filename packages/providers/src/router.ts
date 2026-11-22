import type { ResponseCache, StoredResponse } from "./cache.ts";
import { isPriced, listPriceUsd } from "./cost.ts";
import { BudgetExceededError, realClock, type Clock, type UsageLedger } from "./ledger.ts";
import { canonicalJson, redactDeep, sha256 } from "./redact.ts";
import { CassetteMissError, type CassetteStore, type ProviderMode } from "./replay.ts";
import {
  ProviderError,
  type Attempt,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ProviderResult,
} from "./types.ts";

export interface RouterOptions {
  /** In priority order: primary first, then fallbacks. */
  providers: ModelProvider[];
  mode: ProviderMode;
  cassettes?: CassetteStore;
  cache?: ResponseCache;
  /** Required for any mode that can make a live call. */
  ledger?: UsageLedger;
  /** Attempts per provider, including the first. Spec: bounded retry. */
  maxAttempts?: number;
  timeoutMs?: number;
  /**
   * After a provider answers "rate limited", skip it for this long (no ledger slot, no request).
   * Free-tier 429s usually mean the quota is spent; asking again only burns more quota.
   * Default 15 minutes.
   */
  rateLimitCooldownMs?: number;
  clock?: Clock;
  /** Date used to pick the list price (YYYY-MM-DD); defaults to today. */
  priceDate?: () => string;
}

export interface Router {
  readonly id: string;
  complete(req: ChatRequest): Promise<ChatResponse>;
  stats(): { liveCalls: number; fromCache: number; fromCassette: number };
}

/** Every provider's model must have a published price; anything else is refused up front. */
function assertApproved(providers: ModelProvider[]) {
  for (const p of providers) {
    if (!isPriced(p.id, p.model)) {
      throw new Error(
        `${p.id}/${p.model} is not on the approved free-tier model list (RATES in cost.ts)`,
      );
    }
  }
}

function validate(req: ChatRequest) {
  if (req.tools?.length && req.responseSchema) {
    throw new Error(
      "A request may offer tools or ask for a responseSchema, not both (Groq cannot combine them).",
    );
  }
  if (!req.messages.length) throw new Error("A request needs at least one message.");
}

/** Rough pre-call token estimate (4 characters a token) for tokens-per-minute pacing. */
const estimateTokens = (req: ChatRequest) =>
  Math.ceil(
    canonicalJson({ s: req.system, m: req.messages, t: req.tools, r: req.responseSchema }).length /
      4,
  ) + (req.maxOutputTokens ?? 1024);

export function createRouter(opts: RouterOptions): Router {
  if (!opts.providers.length) throw new Error("Router needs at least one provider");
  assertApproved(opts.providers);
  const clock = opts.clock ?? realClock;
  const maxAttempts = opts.maxAttempts ?? 2;
  const cooldownMs = opts.rateLimitCooldownMs ?? 15 * 60_000;
  /** Circuit breaker: provider → time until which it is skipped after a rate limit. */
  const coolingUntil = new Map<string, number>();
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const priceDate = opts.priceDate ?? (() => new Date(clock.now()).toISOString().slice(0, 10));
  const id = opts.providers
    .map((p) => `${p.id}:${p.model}:${canonicalJson(p.settings)}`)
    .join(" > ");
  const stats = { liveCalls: 0, fromCache: 0, fromCassette: 0 };

  if (opts.mode !== "replay" && !opts.ledger)
    throw new Error(`mode "${opts.mode}" can call APIs, so it needs a usage ledger`);
  if (opts.mode !== "live" && !opts.cassettes)
    throw new Error(`mode "${opts.mode}" needs a cassette store`);

  // The key is computed from the REDACTED request, so a recording run and a later replay run
  // (which feeds back redacted answers) always produce the same keys turn after turn.
  // The route part of the key is the SET of providers (sorted), not their order: swapping
  // primary and fallback keeps every recording valid, while a model or setting change still
  // invalidates it. (Sorted "gemini…" before "groq…", so earlier keys are unchanged.)
  const routeKey = opts.providers
    .map((p) => `${p.id}:${p.model}:${canonicalJson(p.settings)}`)
    .sort()
    .join(" > ");
  const keyOf = (req: ChatRequest) =>
    sha256(canonicalJson({ v: 1, route: routeKey, request: redactDeep(req) }));

  const finish = (
    key: string,
    stored: StoredResponse,
    source: ChatResponse["source"],
    ms: number,
    attempts: Attempt[],
    waitMs = 0,
  ): ChatResponse => ({
    ...stored.result,
    provider: stored.provider,
    model: stored.model,
    source,
    key,
    listPriceUsd: listPriceUsd(stored.provider, stored.model, stored.result.usage, priceDate()),
    latencyMs: Math.round(ms - waitMs),
    waitMs: Math.round(waitMs),
    attempts,
  });

  async function callLive(
    req: ChatRequest,
  ): Promise<{ stored: StoredResponse; attempts: Attempt[]; waitMs: number }> {
    let waitMs = 0; // time spent in our own pacing, reported apart from model latency
    const attempts: Attempt[] = [];
    let lastError: unknown;
    for (const provider of opts.providers) {
      if ((coolingUntil.get(provider.id) ?? 0) > clock.now()) {
        // Circuit open: this provider rate-limited recently. Skip it without spending anything.
        attempts.push({
          provider: provider.id,
          model: provider.model,
          ok: false,
          code: "circuit_open",
          ms: 0,
        });
        continue;
      }
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const w0 = clock.now();
          await opts.ledger!.acquire(provider.id, estimateTokens(req));
          waitMs += clock.now() - w0;
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            lastError = err;
            break; // this provider's budget is spent: no call, try the next provider
          }
          throw err;
        }
        const started = clock.now();
        try {
          const result: ProviderResult = await provider.complete(
            req,
            AbortSignal.timeout(timeoutMs),
          );
          stats.liveCalls++;
          const u = result.usage;
          opts.ledger!.record(provider.id, u.inputTokens + u.outputTokens + u.thinkingTokens);
          attempts.push({
            provider: provider.id,
            model: provider.model,
            ok: true,
            ms: clock.now() - started,
          });
          return {
            stored: { provider: provider.id, model: provider.model, result },
            attempts,
            waitMs,
          };
        } catch (err) {
          stats.liveCalls++;
          lastError = err;
          const pe = err instanceof ProviderError ? err : undefined;
          attempts.push({
            provider: provider.id,
            model: provider.model,
            ok: false,
            status: pe?.status,
            code: pe?.code ?? "unknown",
            ms: clock.now() - started,
          });
          if (pe?.code === "rate_limited") {
            // Never retry a rate limit: open the circuit and fall back straight away.
            coolingUntil.set(provider.id, clock.now() + cooldownMs);
            break;
          }
          if (!pe?.retryable || attempt === maxAttempts) break; // give up on this provider, fall back
          // Back off: honour retry-after when the provider sends it, else 2s, 4s, ... capped at 20s.
          await clock.sleep(Math.min(pe.retryAfterMs ?? 2000 * 2 ** (attempt - 1), 20_000));
        }
      }
    }
    const summary =
      attempts.map((a) => `${a.provider}:${a.ok ? "ok" : (a.code ?? "error")}`).join(", ") ||
      "no attempt made";
    const error = new Error(
      `All providers failed (${summary}): ${(lastError as Error)?.message ?? "unknown"}`,
    );
    (error as Error & { attempts: Attempt[] }).attempts = attempts;
    throw error;
  }

  return {
    id,
    async complete(req) {
      validate(req);
      const t0 = clock.now();
      const key = keyOf(req);

      if (opts.mode === "replay" || opts.mode === "record-missing") {
        const hit = opts.cassettes!.get(key);
        if (hit) {
          stats.fromCassette++;
          return {
            ...finish(key, hit, "cassette", clock.now() - t0, []),
            ...(hit.latencyMs !== undefined ? { recordedLatencyMs: hit.latencyMs } : {}),
          };
        }
        if (opts.mode === "replay") throw new CassetteMissError(key, redactDeep(req));
      }
      if (opts.mode === "live" && opts.cache) {
        const hit = opts.cache.get(key);
        if (hit) {
          stats.fromCache++;
          return finish(key, hit, "cache", clock.now() - t0, []);
        }
      }

      const { stored, attempts, waitMs } = await callLive(req);
      if (opts.mode === "record" || opts.mode === "record-missing") {
        // Return exactly what was stored, so the rest of this run matches a later replay.
        const redacted = redactDeep(stored);
        opts.cassettes!.put({
          version: 1,
          key,
          recordedAt: new Date(clock.now()).toISOString(),
          request: redactDeep(req),
          latencyMs: Math.round(clock.now() - t0 - waitMs),
          ...redacted,
        });
        return finish(key, redacted, "live", clock.now() - t0, attempts, waitMs);
      }
      opts.cache?.set(key, stored);
      return finish(key, stored, "live", clock.now() - t0, attempts, waitMs);
    },
    stats: () => ({ ...stats }),
  };
}

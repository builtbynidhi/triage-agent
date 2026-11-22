import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderId } from "./types.ts";

/**
 * Free-tier guard. Every live call must pass through here first:
 *   - a daily call cap per provider, persisted on disk, so separate processes on the same day
 *     share one budget, set well below the free limits;
 *   - a cap per process (one eval run cannot burn the whole day);
 *   - pacing: a minimum gap between calls, and a tokens-per-minute window, so we stay under
 *     the per-minute limits instead of hitting 429s and retrying.
 * When a cap is reached the call is refused (BudgetExceededError): no request is sent.
 */
export interface ProviderLimits {
  callsPerDay: number;
  minIntervalMs: number;
  tokensPerMinute: number;
}

/**
 * Conservative defaults, measured or read on 2026-11-22.
 * Groq gpt-oss-120b free: 30 RPM, 1000 RPD, 8000 TPM (rate-limit headers on a live call).
 * Gemini free-tier limits are shown only in AI Studio and "not guaranteed", so the cap is
 * kept low and the pacing slow.
 */
export const DEFAULT_LIMITS: Record<ProviderId, ProviderLimits> = {
  gemini: { callsPerDay: 200, minIntervalMs: 6_000, tokensPerMinute: 100_000 },
  groq: { callsPerDay: 700, minIntervalMs: 3_000, tokensPerMinute: 6_000 },
};

export class BudgetExceededError extends Error {
  readonly provider: ProviderId;
  constructor(provider: ProviderId, message: string) {
    super(message);
    this.name = "BudgetExceededError";
    this.provider = provider;
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface LedgerOptions {
  /** Directory for per-day usage files. Omit for an in-memory ledger (tests). */
  dir?: string;
  limits?: Partial<Record<ProviderId, Partial<ProviderLimits>>>;
  maxCallsPerProcess?: number;
  clock?: Clock;
}

interface DayFile {
  date: string;
  calls: Record<string, number>;
  tokens: Record<string, number>;
}

export interface UsageLedger {
  /** Reserve one live call, waiting for pacing. Throws BudgetExceededError if a cap is reached. */
  acquire(provider: ProviderId, estimatedTokens: number): Promise<void>;
  /** Record the tokens a finished call actually used. */
  record(provider: ProviderId, tokens: number): void;
  snapshot(): { date: string; calls: Record<string, number>; processCalls: number };
}

export function createLedger(opts: LedgerOptions = {}): UsageLedger {
  const clock = opts.clock ?? realClock;
  const limits = (p: ProviderId): ProviderLimits => ({ ...DEFAULT_LIMITS[p], ...opts.limits?.[p] });
  const maxPerProcess = opts.maxCallsPerProcess ?? 150;
  let processCalls = 0;
  const lastCallAt: Partial<Record<ProviderId, number>> = {};
  const window: Record<string, { at: number; tokens: number }[]> = {};
  let memory: DayFile | undefined;

  const today = () => new Date(clock.now()).toISOString().slice(0, 10);
  const pathFor = (date: string) => join(opts.dir!, `${date}.json`);

  const load = (): DayFile => {
    const date = today();
    if (!opts.dir) {
      if (memory?.date !== date) memory = { date, calls: {}, tokens: {} };
      return memory;
    }
    try {
      return JSON.parse(readFileSync(pathFor(date), "utf8")) as DayFile;
    } catch {
      return { date, calls: {}, tokens: {} };
    }
  };
  const save = (f: DayFile) => {
    if (!opts.dir) {
      memory = f;
      return;
    }
    mkdirSync(opts.dir, { recursive: true });
    const tmp = `${pathFor(f.date)}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2));
    renameSync(tmp, pathFor(f.date)); // atomic, so a crash never leaves half a file
  };

  return {
    async acquire(provider, estimatedTokens) {
      const l = limits(provider);
      const day = load();
      if (processCalls >= maxPerProcess) {
        throw new BudgetExceededError(
          provider,
          `live-call cap for this process reached (${maxPerProcess})`,
        );
      }
      if ((day.calls[provider] ?? 0) >= l.callsPerDay) {
        throw new BudgetExceededError(
          provider,
          `${provider}: daily cap of ${l.callsPerDay} calls reached for ${day.date} (kept below the free limit on purpose)`,
        );
      }
      // Pacing: minimum gap since the previous call.
      const since = clock.now() - (lastCallAt[provider] ?? -Infinity);
      if (since < l.minIntervalMs) await clock.sleep(l.minIntervalMs - since);
      // Tokens-per-minute window.
      const w = (window[provider] ??= []);
      for (;;) {
        const cutoff = clock.now() - 60_000;
        while (w.length && w[0]!.at <= cutoff) w.shift();
        const used = w.reduce((s, x) => s + x.tokens, 0);
        if (used === 0 || used + estimatedTokens <= l.tokensPerMinute) break;
        await clock.sleep(w[0]!.at + 60_000 - clock.now() + 10);
      }
      day.calls[provider] = (day.calls[provider] ?? 0) + 1;
      save(day);
      processCalls++;
      lastCallAt[provider] = clock.now();
      w.push({ at: clock.now(), tokens: estimatedTokens });
    },
    record(provider, tokens) {
      const w = window[provider];
      const last = w?.at(-1);
      if (last) last.tokens = tokens; // replace the estimate with the real count
      const day = load();
      day.tokens[provider] = (day.tokens[provider] ?? 0) + tokens;
      save(day);
    },
    snapshot() {
      const day = load();
      return { date: day.date, calls: { ...day.calls }, processCalls };
    },
  };
}

export const defaultLedgerDir = (repoRoot: string) => join(repoRoot, ".cache", "usage");
export const ensureDir = (file: string) => mkdirSync(dirname(file), { recursive: true });

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
  /** Daily token cap (Groq's free tier limits tokens per day as well as requests). */
  tokensPerDay: number;
  /**
   * The IANA time zone whose midnight starts the provider's quota day. Each provider is counted
   * on its own clock, because they do not reset together: Groq at 00:00 UTC (05:30 IST),
   * Gemini at midnight Pacific (13:30 IST in winter, 12:30 IST in summer).
   */
  resetTimeZone: string;
}

/**
 * Set below the MEASURED free limits (2026-11-22), with each provider's MEASURED reset time:
 *   Gemini gemini-3.6-flash: 20 requests per day per project (Google's own 429:
 *     "GenerateRequestsPerDayPerProjectPerModel-FreeTier", limit 20). An earlier guess of 200
 *     was ten times too high; Google publishes free limits only inside AI Studio.
 *   Groq gpt-oss-120b: 30 RPM, 1,000 RPD, 8,000 TPM (response headers), 200,000 TPD (docs).
 * Gemini's day starts at midnight Pacific (Google's documented reset; seen here at 13:30 IST).
 * Counting it on the UTC day instead, as this ledger first did, reset Gemini's count at 05:30 IST
 * while Google's did not reset until 13:30 IST: for those eight hours the ledger allowed 18 calls
 * when only what was left of the real quota remained. Groq's day was measured at 00:00 UTC.
 */
export const DEFAULT_LIMITS: Record<ProviderId, ProviderLimits> = {
  gemini: {
    callsPerDay: 18,
    minIntervalMs: 6_000,
    tokensPerMinute: 100_000,
    tokensPerDay: 1_000_000,
    resetTimeZone: "America/Los_Angeles",
  },
  groq: {
    callsPerDay: 700,
    minIntervalMs: 3_000,
    tokensPerMinute: 6_000,
    tokensPerDay: 180_000,
    resetTimeZone: "UTC",
  },
};

/** The provider's quota day at `ms`, as YYYY-MM-DD in its reset time zone. */
export function quotaDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

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
  /**
   * Directory for per-day usage files. Omit for an in-memory ledger (tests). `<date>.json` holds,
   * for each provider, its count for ITS quota day named `<date>`: for Groq the UTC day, for
   * Gemini the Pacific day. The format is unchanged, so readers of Groq's count are unaffected.
   */
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
  /** Each provider's quota day and its call count on that day. */
  snapshot(): { days: Record<string, string>; calls: Record<string, number>; processCalls: number };
}

export function createLedger(opts: LedgerOptions = {}): UsageLedger {
  const clock = opts.clock ?? realClock;
  const limits = (p: ProviderId): ProviderLimits => ({ ...DEFAULT_LIMITS[p], ...opts.limits?.[p] });
  const maxPerProcess = opts.maxCallsPerProcess ?? 150;
  let processCalls = 0;
  const lastCallAt: Partial<Record<ProviderId, number>> = {};
  const window: Record<string, { at: number; tokens: number }[]> = {};
  const memory = new Map<string, DayFile>();

  const dayOf = (p: ProviderId) => quotaDay(clock.now(), limits(p).resetTimeZone);
  const pathFor = (date: string) => join(opts.dir!, `${date}.json`);

  const load = (provider: ProviderId): DayFile => {
    const date = dayOf(provider);
    if (!opts.dir) {
      if (!memory.has(date)) memory.set(date, { date, calls: {}, tokens: {} });
      return memory.get(date)!;
    }
    try {
      return JSON.parse(readFileSync(pathFor(date), "utf8")) as DayFile;
    } catch {
      return { date, calls: {}, tokens: {} };
    }
  };
  const save = (f: DayFile) => {
    if (!opts.dir) {
      memory.set(f.date, f);
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
      const day = load(provider);
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
      if ((day.tokens[provider] ?? 0) + estimatedTokens > l.tokensPerDay) {
        throw new BudgetExceededError(
          provider,
          `${provider}: daily token cap of ${l.tokensPerDay} reached for ${day.date} (kept below the free limit on purpose)`,
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
      const day = load(provider);
      day.tokens[provider] = (day.tokens[provider] ?? 0) + tokens;
      save(day);
    },
    snapshot() {
      const days: Record<string, string> = {};
      const calls: Record<string, number> = {};
      for (const p of Object.keys(DEFAULT_LIMITS) as ProviderId[]) {
        const day = load(p);
        days[p] = day.date;
        calls[p] = day.calls[p] ?? 0;
      }
      return { days, calls, processCalls };
    },
  };
}

export const defaultLedgerDir = (repoRoot: string) => join(repoRoot, ".cache", "usage");
export const ensureDir = (file: string) => mkdirSync(dirname(file), { recursive: true });

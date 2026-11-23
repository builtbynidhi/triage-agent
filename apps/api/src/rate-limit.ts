import type { NextFunction, Request, Response } from "express";
import { principalOf } from "./auth.ts";
import { problem } from "./problem.ts";

/**
 * A token bucket per merchant: `capacity` requests at once, refilled at `refillPerSec`. In memory,
 * which is right for one API process; several processes would need a shared store (not built, and
 * not needed here). Keyed by the merchant from the verified token, so one noisy merchant cannot
 * use up another's allowance.
 */
export interface RateLimiter {
  take(key: string): { ok: true } | { ok: false; retryAfterSec: number };
}

export function createRateLimiter(opts: {
  capacity: number;
  refillPerSec: number;
  now?: () => number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key) {
      const t = now();
      const b = buckets.get(key) ?? { tokens: opts.capacity, at: t };
      b.tokens = Math.min(opts.capacity, b.tokens + ((t - b.at) / 1000) * opts.refillPerSec);
      b.at = t;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        buckets.set(key, b);
        return { ok: true };
      }
      buckets.set(key, b);
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / opts.refillPerSec)),
      };
    },
  };
}

export function rateLimit(limiter: RateLimiter) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const r = limiter.take(principalOf(res).tenantId);
    if (r.ok) return next();
    res.setHeader("Retry-After", String(r.retryAfterSec));
    problem(res, 429, "Too Many Requests", `Slow down; try again in ${r.retryAfterSec}s.`);
  };
}

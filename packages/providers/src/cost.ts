import type { ProviderId, Usage } from "./types.ts";

/**
 * Paid list prices, USD per 1M tokens, for the "cost per 100 tickets" metric. On the free tiers
 * this project uses, actual spend is $0; these numbers say what the same traffic would cost on
 * a paid plan. Thinking tokens are billed as output by both providers.
 *
 * Sources, checked 2026-11-22:
 *   Gemini: https://aistudio.google.com/docs/pricing (Standard tab)
 *   Groq:   https://console.groq.com/docs/models
 */
export interface Rate {
  provider: ProviderId;
  model: string;
  /** First day (YYYY-MM-DD, inclusive) this price applies. */
  from: string;
  inputPerM: number;
  outputPerM: number;
}

export const RATES: readonly Rate[] = [
  // "$0.75 through December 31, 2026", "$1.50 starting January 1, 2027" (output $3.75 / $7.50)
  {
    provider: "gemini",
    model: "gemini-3.6-flash",
    from: "2000-01-01",
    inputPerM: 0.75,
    outputPerM: 3.75,
  },
  {
    provider: "gemini",
    model: "gemini-3.6-flash",
    from: "2027-01-01",
    inputPerM: 1.5,
    outputPerM: 7.5,
  },
  {
    provider: "gemini",
    model: "gemini-3.8-flash",
    from: "2000-01-01",
    inputPerM: 0.75,
    outputPerM: 3.75,
  },
  {
    provider: "gemini",
    model: "gemini-3.8-flash",
    from: "2027-01-01",
    inputPerM: 1.5,
    outputPerM: 7.5,
  },
  {
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    from: "2000-01-01",
    inputPerM: 0.3,
    outputPerM: 2.5,
  },
  {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    from: "2000-01-01",
    inputPerM: 0.15,
    outputPerM: 0.6,
  },
  {
    provider: "groq",
    model: "openai/gpt-oss-20b",
    from: "2000-01-01",
    inputPerM: 0.075,
    outputPerM: 0.3,
  },
];

export class UnknownRateError extends Error {
  constructor(provider: string, model: string) {
    super(
      `No list price for ${provider}/${model}. Add it to RATES in packages/providers/src/cost.ts with its source.`,
    );
    this.name = "UnknownRateError";
  }
}

/** The rate in force on a given day (the latest entry whose `from` is on or before it). */
export function rateFor(provider: ProviderId, model: string, onDate: string): Rate {
  const candidates = RATES.filter(
    (r) => r.provider === provider && r.model === model && r.from <= onDate,
  );
  if (!candidates.length) throw new UnknownRateError(provider, model);
  return candidates.reduce((a, b) => (b.from > a.from ? b : a));
}

/** List-price cost of one call, in USD. Never silently $0: an unknown model throws. */
export function listPriceUsd(
  provider: ProviderId,
  model: string,
  usage: Usage,
  onDate: string,
): number {
  const r = rateFor(provider, model, onDate);
  const usd =
    (usage.inputTokens * r.inputPerM + (usage.outputTokens + usage.thinkingTokens) * r.outputPerM) /
    1e6;
  return Math.round(usd * 1e10) / 1e10;
}

/** True if a model is on the approved list (the only models the router may call). */
export const isPriced = (provider: ProviderId, model: string): boolean =>
  RATES.some((r) => r.provider === provider && r.model === model);

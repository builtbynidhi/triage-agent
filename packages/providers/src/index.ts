import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileCache } from "./cache.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createGroqProvider } from "./groq.ts";
import { createLedger, defaultLedgerDir } from "./ledger.ts";
import { createCassetteStore, modeFromEnv, type ProviderMode } from "./replay.ts";
import { createRouter, type Router } from "./router.ts";
import type { ModelProvider } from "./types.ts";

export * from "./types.ts";
export {
  createGeminiProvider,
  buildGeminiBody,
  parseGeminiResponse,
  toGeminiContents,
} from "./gemini.ts";
export { createGroqProvider, buildGroqBody, parseGroqResponse } from "./groq.ts";
export { createRouter } from "./router.ts";
export type { Router, RouterOptions } from "./router.ts";
export { createMemoryCache, createFileCache } from "./cache.ts";
export type { ResponseCache, StoredResponse } from "./cache.ts";
export {
  createCassetteStore,
  createMemoryCassetteStore,
  modeFromEnv,
  CassetteMissError,
  MODES,
} from "./replay.ts";
export type { Cassette, CassetteStore, ProviderMode } from "./replay.ts";
export { createLedger, BudgetExceededError, DEFAULT_LIMITS, realClock } from "./ledger.ts";
export type { UsageLedger, ProviderLimits, Clock } from "./ledger.ts";
export { RATES, listPriceUsd, rateFor, UnknownRateError } from "./cost.ts";
export { redactText, redactDeep, canonicalJson, sha256 } from "./redact.ts";

/**
 * The production model route (decided 2026-11-22, see DESIGN.md §2.4): Gemini primary, Groq
 * fallback. Pinned exact versions, never "-latest" aliases, so recordings stay reproducible.
 */
export const GROQ_ROUTE = {
  provider: "groq",
  model: "openai/gpt-oss-120b",
  reasoningEffort: "low",
} as const;
export const GEMINI_ROUTE = {
  provider: "gemini",
  model: "gemini-3.6-flash",
  thinkingLevel: "LOW",
} as const;
/**
 * Groq first (owner's decision, 2026-11-22): measured free limits are Groq gpt-oss-120b 1,000
 * requests and 200k tokens a day, but Gemini 3.6 Flash only 20 requests a day (from Google's own
 * 429), too few to record or re-run an eval suite. Gemini remains the fallback.
 */
export const PRIMARY = GROQ_ROUTE;
export const FALLBACK = GEMINI_ROUTE;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CASSETTE_DIR = join(repoRoot, "evals", "cassettes");

/** Minimal .env reader (KEY=value lines), so scripts get keys without another dependency. */
export function loadDotEnv(file = join(repoRoot, ".env")): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(file, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [
            l.slice(0, i).trim(),
            l
              .slice(i + 1)
              .replace(/\s+#.*$/, "")
              .trim(),
          ];
        }),
    );
  } catch {
    return {};
  }
}

/**
 * The router every caller uses. Replay mode (the default) needs no keys and never touches the
 * network. Other modes read GEMINI_API_KEY and GROQ_API_KEY from the environment or .env.
 */
export function createDefaultRouter(
  options: {
    mode?: ProviderMode;
    env?: Record<string, string | undefined>;
    cassetteDir?: string;
  } = {},
): Router {
  // An explicitly passed env is used as is (tests must never pick up real keys from .env).
  const env = options.env ?? { ...loadDotEnv(), ...process.env };
  const mode = options.mode ?? modeFromEnv(env);
  const build = (keys: { groq: string; gemini: string }): ModelProvider[] => [
    createGroqProvider({
      apiKey: keys.groq,
      model: GROQ_ROUTE.model,
      reasoningEffort: GROQ_ROUTE.reasoningEffort,
    }),
    createGeminiProvider({
      apiKey: keys.gemini,
      model: GEMINI_ROUTE.model,
      thinkingLevel: GEMINI_ROUTE.thinkingLevel,
    }),
  ];
  // Replay needs no keys: key-less providers with the same identity are never called, and keep
  // the route (and so every recording key) identical to the one used when recording.
  if (mode !== "replay" && (!env.GEMINI_API_KEY || !env.GROQ_API_KEY)) {
    throw new Error(
      `PROVIDER_MODE=${mode} calls live APIs and needs both GEMINI_API_KEY and GROQ_API_KEY in .env ` +
        "(both, so the route, and therefore every recording key, is the same on every machine).",
    );
  }
  const providers =
    mode === "replay"
      ? build({ groq: "", gemini: "" })
      : build({ groq: env.GROQ_API_KEY!, gemini: env.GEMINI_API_KEY! });
  return createRouter({
    providers,
    mode,
    cassettes: createCassetteStore(options.cassetteDir ?? CASSETTE_DIR),
    cache: createFileCache(join(repoRoot, ".cache", "llm")),
    ledger: mode === "replay" ? undefined : createLedger({ dir: defaultLedgerDir(repoRoot) }),
  });
}

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryCache } from "./cache.ts";
import { listPriceUsd, rateFor, UnknownRateError } from "./cost.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createGroqProvider } from "./groq.ts";
import { BudgetExceededError, createLedger } from "./ledger.ts";
import { canonicalJson, redactDeep, redactText } from "./redact.ts";
import {
  CassetteMissError,
  createCassetteStore,
  createMemoryCassetteStore,
  modeFromEnv,
  type ProviderMode,
} from "./replay.ts";
import { createRouter } from "./router.ts";
import { fakeClock, fakeFetch, geminiOk, groqOk } from "./test-helpers.ts";
import { codeForResponse, ProviderError, type ChatRequest } from "./types.ts";
import { createDefaultRouter } from "./index.ts";

/**
 * Fake, key-shaped strings for the redaction tests, built at runtime so the source never
 * contains a literal key (the pre-commit secret scan rightly blocks those).
 */
const FAKE = {
  groq: "gsk" + "_" + "A".repeat(24),
  googleClassic: "AI" + "za" + "B".repeat(35),
  googleNew: "AQ" + "." + "C".repeat(24),
  signature: "AI" + "za" + "D".repeat(35) + "+sig==",
};

const req = (text = "Where is my order A-10413?"): ChatRequest => ({
  system: "You triage tickets.",
  messages: [{ role: "user", content: text }],
});

function setup(
  opts: {
    mode?: ProviderMode;
    primary?: Parameters<typeof fakeFetch>[0];
    fallback?: Parameters<typeof fakeFetch>[0];
    clock?: ReturnType<typeof fakeClock>;
    maxAttempts?: number;
    ledger?: ReturnType<typeof createLedger>;
  } = {},
) {
  const gemini = fakeFetch(opts.primary ?? [{ body: geminiOk("from gemini") }]);
  const groq = fakeFetch(opts.fallback ?? [{ body: groqOk("from groq") }]);
  const clock = opts.clock ?? fakeClock();
  const cassettes = createMemoryCassetteStore();
  const router = createRouter({
    providers: [
      createGeminiProvider({ apiKey: "g", model: "gemini-3.6-flash", fetch: gemini }),
      createGroqProvider({ apiKey: "q", model: "openai/gpt-oss-120b", fetch: groq }),
    ],
    mode: opts.mode ?? "live",
    cassettes,
    cache: createMemoryCache(),
    ledger: opts.ledger ?? createLedger({ clock }),
    maxAttempts: opts.maxAttempts ?? 2,
    clock,
  });
  return { router, gemini, groq, clock, cassettes };
}

describe("done when: the same request twice makes exactly one live call", () => {
  it("live mode: the second identical request is served from the cache", async () => {
    const { router, gemini, groq } = setup();
    const a = await router.complete(req());
    const b = await router.complete(req());
    expect(gemini.calls.length + groq.calls.length).toBe(1);
    expect([a.source, b.source]).toEqual(["live", "cache"]);
    expect(b.text).toBe(a.text);
    expect(router.stats()).toEqual({ liveCalls: 1, fromCache: 1, fromCassette: 0 });
  });

  it("record-missing mode: the second identical request is served from the new cassette", async () => {
    const { router, gemini, cassettes } = setup({ mode: "record-missing" });
    await router.complete(req());
    const second = await router.complete(req());
    expect(gemini.calls).toHaveLength(1);
    expect(second.source).toBe("cassette");
    expect(cassettes.all()).toHaveLength(1);
  });

  it("a different request is a different key and does call again", async () => {
    const { router, gemini } = setup();
    await router.complete(req("A"));
    await router.complete(req("B"));
    expect(gemini.calls).toHaveLength(2);
  });
});

describe("fallback and bounded retry", () => {
  it("falls back to Groq when Gemini keeps failing", async () => {
    const { router, gemini, groq } = setup({
      primary: [{ status: 503, body: { error: { message: "high demand" } } }],
    });
    const r = await router.complete(req());
    expect(r.provider).toBe("groq");
    expect(r.text).toBe("from groq");
    expect(gemini.calls).toHaveLength(2); // maxAttempts = 2: one retry, then give up on it
    expect(groq.calls).toHaveLength(1);
    expect(r.attempts.map((a) => `${a.provider}:${a.ok ? "ok" : a.code}`)).toEqual([
      "gemini:unavailable",
      "gemini:unavailable",
      "groq:ok",
    ]);
  });

  it("retries a transient failure and succeeds without falling back", async () => {
    const { router, gemini, groq } = setup({
      primary: [{ status: 503, body: {} }, { body: geminiOk("second try") }],
    });
    const r = await router.complete(req());
    expect(r.text).toBe("second try");
    expect(gemini.calls).toHaveLength(2);
    expect(groq.calls).toHaveLength(0);
  });

  it("honours retry-after before retrying", async () => {
    const { router, clock } = setup({
      primary: [
        { status: 503, headers: { "retry-after": "7" }, body: {} },
        { body: geminiOk("ok") },
      ],
    });
    await router.complete(req());
    expect(clock.slept).toContain(7000);
  });

  it("never retries a non-transient error (auth, billing): straight to the fallback", async () => {
    for (const status of [401, 402]) {
      const { router, gemini, groq } = setup({
        primary: [{ status, body: { error: { message: "no" } } }],
      });
      const r = await router.complete(req());
      expect(gemini.calls).toHaveLength(1);
      expect(groq.calls).toHaveLength(1);
      expect(r.provider).toBe("groq");
    }
  });

  it("falls back when Gemini rejects tool history without thought signatures (400)", async () => {
    // Measured live: after a Groq-answered tool turn, Gemini refuses the next call with
    // "Function call is missing a thought_signature" (400). Not retryable, but the fallback can serve it.
    const { router, gemini, groq } = setup({
      primary: [
        {
          status: 400,
          body: { error: { message: "Function call is missing a thought_signature" } },
        },
      ],
    });
    const r = await router.complete(req());
    expect(gemini.calls).toHaveLength(1);
    expect(groq.calls).toHaveLength(1);
    expect(r.provider).toBe("groq");
  });

  it("never retries a rate limit: one 429, then straight to the fallback", async () => {
    const { router, gemini, groq } = setup({ primary: [{ status: 429, body: {} }] });
    const r = await router.complete(req());
    expect(gemini.calls).toHaveLength(1); // no retry: a free-tier 429 means the quota is spent
    expect(groq.calls).toHaveLength(1);
    expect(r.provider).toBe("groq");
  });

  it("circuit breaker: after a 429, the provider is skipped (no request) until the cooldown ends", async () => {
    const clock = fakeClock();
    const { router, gemini, groq } = setup({
      clock,
      primary: [{ status: 429, body: {} }, { body: geminiOk("back") }],
      fallback: [{ body: groqOk("one") }, { body: groqOk("two") }],
    });
    await router.complete(req("first")); // gemini 429 → circuit opens → groq
    const second = await router.complete(req("second")); // gemini skipped entirely
    expect(gemini.calls).toHaveLength(1);
    expect(second.provider).toBe("groq");
    expect(groq.calls).toHaveLength(2); // the fallback served both while the circuit was open
    expect(second.attempts[0]).toMatchObject({ provider: "gemini", code: "circuit_open" });
    await clock.sleep(15 * 60_000 + 1); // cooldown over
    const third = await router.complete(req("third"));
    expect(third.provider).toBe("gemini");
    expect(gemini.calls).toHaveLength(2);
  });

  it("when every provider fails, throws with every attempt listed", async () => {
    const { router, gemini, groq } = setup({
      primary: [{ status: 503, body: {} }],
      fallback: [{ status: 503, body: {} }],
    });
    await expect(router.complete(req())).rejects.toThrow(
      /All providers failed \(gemini:unavailable, gemini:unavailable, groq:unavailable, groq:unavailable\)/,
    );
    expect(gemini.calls.length + groq.calls.length).toBe(4); // bounded: 2 per provider, never more
  });
});

describe("replay mode", () => {
  it("fails loudly on a missing cassette, and never calls an API", async () => {
    const { router, gemini, groq } = setup({ mode: "replay" });
    const err = await router.complete(req()).catch((e) => e);
    expect(err).toBeInstanceOf(CassetteMissError);
    expect(err.message).toMatch(/Replay mode never calls a live API/);
    expect(err.message).toMatch(/PROVIDER_MODE=record-missing/);
    expect(gemini.calls.length + groq.calls.length).toBe(0);
  });

  it("stores the live latency in the cassette and reports it on replay", async () => {
    const { router, cassettes } = setup({ mode: "record-missing" });
    const live = await router.complete(req());
    const replayed = await router.complete(req());
    expect(cassettes.all()[0]!.latencyMs).toBe(live.latencyMs);
    expect(replayed.source).toBe("cassette");
    expect(replayed.recordedLatencyMs).toBe(live.latencyMs);
  });

  it("serves a recorded answer with no network at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cassettes-"));
    const live = fakeFetch([{ body: geminiOk("recorded answer") }]);
    const providers = (fetch: ReturnType<typeof fakeFetch>) => [
      createGeminiProvider({ apiKey: "g", model: "gemini-3.6-flash", fetch }),
      createGroqProvider({ apiKey: "q", model: "openai/gpt-oss-120b", fetch }),
    ];
    const clock = fakeClock();
    await createRouter({
      providers: providers(live),
      mode: "record-missing",
      cassettes: createCassetteStore(dir),
      ledger: createLedger({ clock }),
      clock,
    }).complete(req());
    const dead = fakeFetch([new Error("network must not be used in replay")]);
    const r = await createRouter({
      providers: providers(dead),
      mode: "replay",
      cassettes: createCassetteStore(dir),
      clock,
    }).complete(req());
    expect(r.text).toBe("recorded answer");
    expect(r.source).toBe("cassette");
    expect(dead.calls).toHaveLength(0);
  });

  it("a multi-turn conversation recorded once replays with identical keys (thought signatures intact)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cassettes-"));
    const turn1 = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: { name: "get_order", args: { order_id: "A-1" }, id: "c1" },
                thoughtSignature: "c2stYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    };
    const turn2 = geminiOk("A-1 is on its way. Contact a***1@example.com");
    const run = async (mode: ProviderMode, fetch: ReturnType<typeof fakeFetch>) => {
      const clock = fakeClock();
      const router = createRouter({
        providers: [
          createGeminiProvider({ apiKey: "g", model: "gemini-3.6-flash", fetch }),
          createGroqProvider({ apiKey: "q", model: "openai/gpt-oss-120b", fetch }),
        ],
        mode,
        cassettes: createCassetteStore(dir),
        ledger: createLedger({ clock }),
        clock,
      });
      const first = await router.complete(
        req("Where is A-1? My email is asha.sharma1@example.com"),
      );
      const second = await router.complete({
        ...req("Where is A-1? My email is asha.sharma1@example.com"),
        messages: [
          { role: "user", content: "Where is A-1? My email is asha.sharma1@example.com" },
          {
            role: "assistant",
            content: first.text,
            toolCalls: first.toolCalls,
            providerState: first.providerState,
          },
          { role: "tool", toolCallId: "c1", name: "get_order", content: '{"ok":true}' },
        ],
      });
      return [first.key, second.key, second.text];
    };
    const recorded = await run("record-missing", fakeFetch([{ body: turn1 }, { body: turn2 }]));
    const replayed = await run("replay", fakeFetch([new Error("no network in replay")]));
    expect(replayed).toEqual(recorded);
  });
});

describe("cassettes are safe to commit", () => {
  it("redact keys, emails and phones in the request and the response, but keep thought signatures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cassettes-"));
    const clock = fakeClock();
    const sig = FAKE.signature; // looks like a key, but is an opaque vendor field
    const fetch = fakeFetch([
      {
        body: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: "Call +91 9138271605 or mail meera.patel5@example.com",
                    thoughtSignature: sig,
                  },
                ],
              },
            },
          ],
          usageMetadata: {},
        },
      },
    ]);
    await createRouter({
      providers: [
        createGeminiProvider({ apiKey: "g", model: "gemini-3.6-flash", fetch }),
        createGroqProvider({ apiKey: "q", model: "openai/gpt-oss-120b", fetch }),
      ],
      mode: "record-missing",
      cassettes: createCassetteStore(dir),
      ledger: createLedger({ clock }),
      clock,
    }).complete(req(`key ${FAKE.groq} and phone 9845012345, mail priya.das3@example.com`));
    const text = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    for (const secret of [FAKE.groq, "9845012345", "9138271605", "priya.das3", "meera.patel5"])
      expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED_EMAIL]");
    expect(text).toContain("[REDACTED_PHONE]");
    expect(text).toContain(sig); // opaque vendor field survives untouched
  });

  it("redaction patterns", () => {
    expect(redactText(`${FAKE.googleNew} and ${FAKE.googleClassic}`)).toBe(
      "[REDACTED_KEY] and [REDACTED_KEY]",
    );
    expect(redactText("ph +91-98450 12345 / 9845012345 / order A-10413 / 2026-11-20")).toBe(
      "ph [REDACTED_PHONE] / [REDACTED_PHONE] / order A-10413 / 2026-11-20",
    );
    expect(redactDeep({ a: ["x@y.com"], thoughtSignature: "x@y.com" })).toEqual({
      a: ["[REDACTED_EMAIL]"],
      thoughtSignature: "x@y.com",
    });
  });

  it("request keys ignore object key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

describe("free-tier guard", () => {
  it("refuses a call over the daily cap without sending it, then falls back", async () => {
    const clock = fakeClock();
    const ledger = createLedger({ clock, limits: { gemini: { callsPerDay: 1 } } });
    const { router, gemini, groq } = setup({ ledger });
    await router.complete(req("one"));
    const r = await router.complete(req("two"));
    expect(gemini.calls).toHaveLength(1); // the second call was never sent
    expect(groq.calls).toHaveLength(1);
    expect(r.provider).toBe("groq");
  });

  it("when every provider is over its cap, throws without any request", async () => {
    const clock = fakeClock();
    const ledger = createLedger({
      clock,
      limits: { gemini: { callsPerDay: 0 }, groq: { callsPerDay: 0 } },
    });
    const { router, gemini, groq } = setup({ ledger });
    await expect(router.complete(req())).rejects.toThrow(/daily cap of 0 calls/);
    expect(gemini.calls.length + groq.calls.length).toBe(0);
  });

  it("the daily count is shared across processes through the usage file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const clock = fakeClock();
    await createLedger({ dir, clock, limits: { groq: { callsPerDay: 2 } } }).acquire("groq", 10);
    await createLedger({ dir, clock, limits: { groq: { callsPerDay: 2 } } }).acquire("groq", 10);
    await expect(
      createLedger({ dir, clock, limits: { groq: { callsPerDay: 2 } } }).acquire("groq", 10),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("caps live calls per process", async () => {
    const ledger = createLedger({ clock: fakeClock(), maxCallsPerProcess: 1 });
    await ledger.acquire("gemini", 1);
    await expect(ledger.acquire("groq", 1)).rejects.toThrow(/cap for this process/);
  });

  it("paces calls: a minimum gap, and waits for the tokens-per-minute window", async () => {
    const clock = fakeClock();
    const ledger = createLedger({
      clock,
      limits: { groq: { minIntervalMs: 3000, tokensPerMinute: 1000 } },
    });
    await ledger.acquire("groq", 800);
    await ledger.acquire("groq", 800); // gap first (3s), then the window is full: wait out the minute
    expect(clock.slept[0]).toBe(3000);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });

  it("reports pacing wait separately from model latency", async () => {
    const clock = fakeClock();
    const ledger = createLedger({ clock, limits: { gemini: { minIntervalMs: 6000 } } });
    const { router } = setup({
      ledger,
      clock, // the router and the ledger must share one clock
      primary: [{ body: geminiOk("a") }, { body: geminiOk("b") }],
    });
    const first = await router.complete(req("one"));
    const second = await router.complete(req("two"));
    expect(first.waitMs).toBe(0);
    expect(second.waitMs).toBe(6000); // the pacing gap, not the model's time
    expect(second.latencyMs).toBe(0); // the fake provider itself takes no time
  });

  const REFUSED = {
    status: 400,
    body: {
      error: {
        message:
          "Tool call validation failed: attempted to call tool 'ESCALATE' which was not in request.tools",
      },
    },
  };

  it("classifies a provider refusing the model's own tool call, and nothing else, as model_output_rejected", () => {
    for (const m of [
      "Tool call validation failed: attempted to call tool 'ESCALATE' which was not in request.tools",
      "Tool choice is none, but model called a tool",
      "Failed to call a function. Please adjust your prompt.",
    ])
      expect(codeForResponse(400, m)).toBe("model_output_rejected");
    expect(codeForResponse(400, "Invalid JSON schema")).toBe("bad_request");
    expect(codeForResponse(429, "Tool choice is none")).toBe("rate_limited"); // only a 400 qualifies
    expect(codeForResponse(503, "x")).toBe("unavailable");
  });

  it("a refused model output is never retried and never sent to the fallback", async () => {
    const { router, gemini, groq } = setup({ primary: [REFUSED] });
    const err = await router.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("model_output_rejected");
    expect(gemini.calls).toHaveLength(1); // no retry
    expect(groq.calls).toHaveLength(0); // the other provider would not see the same history
  });

  it("records a refusal as a cassette, and replays it exactly, with no API call", async () => {
    const { router, gemini, cassettes } = setup({ mode: "record-missing", primary: [REFUSED] });
    await expect(router.complete(req())).rejects.toMatchObject({ code: "model_output_rejected" });
    expect(cassettes.all()).toHaveLength(1);
    expect(cassettes.all()[0]).toMatchObject({
      rejection: { provider: "gemini", status: 400, message: expect.stringContaining("ESCALATE") },
    });
    // Asking again is served from the recording: no second call.
    await expect(router.complete(req())).rejects.toMatchObject({ code: "model_output_rejected" });
    expect(gemini.calls).toHaveLength(1);
    // A replay-mode router over the same recordings reproduces it too, and needs no ledger or keys.
    const replay = createRouter({
      providers: [
        createGeminiProvider({ apiKey: "", model: "gemini-3.6-flash" }),
        createGroqProvider({ apiKey: "", model: "openai/gpt-oss-120b" }),
      ],
      mode: "replay",
      cassettes,
    });
    await expect(replay.complete(req())).rejects.toMatchObject({ code: "model_output_rejected" });
  });

  it("primaryOnly: a failing primary is never followed by the fallback", async () => {
    const { router: both, groq: g1 } = setup({
      primary: [{ status: 503, body: {} }],
      maxAttempts: 1,
    });
    await both.complete(req());
    expect(g1.calls).toHaveLength(1); // by default the fallback answers
    const gemini = fakeFetch([{ status: 503, body: {} }]);
    const groq = fakeFetch([{ body: groqOk("x") }]);
    const clock = fakeClock();
    const only = createRouter({
      providers: [
        createGeminiProvider({ apiKey: "g", model: "gemini-3.6-flash", fetch: gemini }),
        createGroqProvider({ apiKey: "q", model: "openai/gpt-oss-120b", fetch: groq }),
      ],
      mode: "live",
      primaryOnly: true,
      ledger: createLedger({ clock }),
      maxAttempts: 1,
      clock,
    });
    await expect(only.complete(req())).rejects.toThrow(/All providers failed/);
    expect(groq.calls).toHaveLength(0);
    expect(only.id).toBe(both.id); // the recording key is unchanged
  });

  it("enforces a daily token cap (Groq's free tier limits tokens per day)", async () => {
    const ledger = createLedger({ clock: fakeClock(), limits: { groq: { tokensPerDay: 1000 } } });
    await ledger.acquire("groq", 400);
    ledger.record("groq", 900);
    await expect(ledger.acquire("groq", 200)).rejects.toThrow(/daily token cap of 1000/);
  });

  it("recording keys ignore provider order, so swapping primary and fallback keeps recordings valid", async () => {
    const make = (order: "gemini-first" | "groq-first") => {
      const g = createGeminiProvider({
        apiKey: "g",
        model: "gemini-3.6-flash",
        fetch: fakeFetch([{ body: geminiOk("x") }]),
      });
      const q = createGroqProvider({
        apiKey: "q",
        model: "openai/gpt-oss-120b",
        fetch: fakeFetch([{ body: groqOk("x") }]),
      });
      const clock = fakeClock();
      return createRouter({
        providers: order === "gemini-first" ? [g, q] : [q, g],
        mode: "live",
        ledger: createLedger({ clock }),
        clock,
      });
    };
    const a = await make("gemini-first").complete(req());
    const b = await make("groq-first").complete(req());
    expect(a.key).toBe(b.key);
    expect([a.provider, b.provider]).toEqual(["gemini", "groq"]); // order still decides who answers
  });

  it("only approved, priced models can be routed to", () => {
    expect(() =>
      createRouter({
        providers: [createGeminiProvider({ apiKey: "k", model: "gemini-4-neon" })],
        mode: "replay",
        cassettes: createMemoryCassetteStore(),
      }),
    ).toThrow(/not on the approved free-tier model list/);
  });
});

describe("cost", () => {
  it("bills input and output, and thinking as output, at the list price", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, thinkingTokens: 500_000 };
    expect(listPriceUsd("gemini", "gemini-3.6-flash", usage, "2026-11-22")).toBe(0.75 + 3.75);
    expect(listPriceUsd("groq", "openai/gpt-oss-120b", usage, "2026-11-22")).toBe(0.15 + 0.6);
  });

  it("switches to the new price on its effective date", () => {
    expect(rateFor("gemini", "gemini-3.6-flash", "2026-12-31").inputPerM).toBe(0.75);
    expect(rateFor("gemini", "gemini-3.6-flash", "2027-01-01").inputPerM).toBe(1.5);
  });

  it("never prices an unknown model as $0", () => {
    expect(() =>
      listPriceUsd(
        "gemini",
        "gemini-9-ultra",
        { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 },
        "2026-11-22",
      ),
    ).toThrow(UnknownRateError);
  });

  it("puts a list price on every response", async () => {
    const { router } = setup();
    const r = await router.complete(req());
    // geminiOk: 100 in, 20 out, 10 thinking → (100*0.75 + 30*3.75) / 1e6
    expect(r.listPriceUsd).toBeCloseTo((100 * 0.75 + 30 * 3.75) / 1e6, 12);
  });
});

describe("request rules and configuration", () => {
  it("rejects a request that has both tools and a response schema", async () => {
    const { router } = setup();
    await expect(
      router.complete({
        ...req(),
        tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
        responseSchema: { name: "s", schema: { type: "object" } },
      }),
    ).rejects.toThrow(/tools or ask for a responseSchema, not both/);
  });

  it("PROVIDER_MODE defaults to replay and rejects anything unknown", () => {
    expect(modeFromEnv({})).toBe("replay");
    expect(modeFromEnv({ PROVIDER_MODE: "record-missing" })).toBe("record-missing");
    expect(() => modeFromEnv({ PROVIDER_MODE: "yolo" })).toThrow(/must be one of/);
  });

  it("the default router in replay mode needs no API keys", () => {
    expect(() => createDefaultRouter({ mode: "replay", env: {} })).not.toThrow();
  });

  it("the default router refuses live modes without both keys", () => {
    expect(() => createDefaultRouter({ mode: "live", env: { GEMINI_API_KEY: "x" } })).toThrow(
      /needs both GEMINI_API_KEY and GROQ_API_KEY/,
    );
  });
});

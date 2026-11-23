import { describe, expect, it } from "vitest";
import {
  buildGeminiBody,
  createGeminiProvider,
  GEMINI_ADAPTER_VERSION,
  parseGeminiResponse,
  THINKING_HEADROOM,
  toGeminiContents,
} from "./gemini.ts";
import {
  buildGroqBody,
  createGroqProvider,
  GROQ_ADAPTER_VERSION,
  parseGroqResponse,
} from "./groq.ts";
import { isStrictCompatible, toGeminiParameters } from "./schema.ts";
import { fakeFetch, geminiOk, groqOk } from "./test-helpers.ts";
import { ProviderError, type ChatRequest, type JsonSchema } from "./types.ts";

/** Read a nested field of a request body by a dotted path, e.g. "messages.2.tool_calls.0". */
const dig = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);

const tool = {
  name: "get_order",
  description: "Look up an order",
  parameters: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      order_id: { type: "string", pattern: "^[A-Z]-\\d{5}$" },
      note: { type: ["string", "null"] },
    },
    required: ["order_id"],
    additionalProperties: false,
  },
};
const signal = () => new AbortController().signal;

describe("Gemini request mapping", () => {
  it("sends the system prompt, temperature, seed and LOW thinking", () => {
    const body = buildGeminiBody(
      { system: "SYS", messages: [{ role: "user", content: "hi" }] },
      "LOW",
    );
    expect(dig(body, "systemInstruction")).toEqual({ parts: [{ text: "SYS" }] });
    expect(dig(body, "generationConfig")).toMatchObject({
      temperature: 0,
      seed: 7,
      thinkingConfig: { thinkingLevel: "LOW" },
    });
    expect(dig(body, "contents")).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("asks for JSON with responseJsonSchema, without $schema", () => {
    const body = buildGeminiBody(
      {
        system: "S",
        messages: [{ role: "user", content: "x" }],
        responseSchema: { name: "d", schema: tool.parameters },
      },
      "LOW",
    );
    expect(dig(body, "generationConfig.responseMimeType")).toBe("application/json");
    expect(dig(body, "generationConfig.responseJsonSchema.$schema")).toBeUndefined();
    expect(dig(body, "tools")).toBeUndefined();
  });

  it("declares tools in Gemini's OpenAPI subset (nullable, no pattern or additionalProperties)", () => {
    const params = toGeminiParameters(tool.parameters);
    expect(params).toEqual({
      type: "object",
      properties: { order_id: { type: "string" }, note: { type: "string", nullable: true } },
      required: ["order_id"],
    });
  });

  it("sends the model's own parts back verbatim, thought signature included", () => {
    const raw = {
      role: "model",
      parts: [
        {
          functionCall: { name: "get_order", args: { order_id: "A-1" }, id: "c1" },
          thoughtSignature: "SIG==",
        },
      ],
    };
    const contents = toGeminiContents([
      { role: "user", content: "where is A-1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "get_order", arguments: { order_id: "A-1" } }],
        providerState: { provider: "gemini", raw },
      },
      { role: "tool", toolCallId: "c1", name: "get_order", content: '{"ok":true}' },
      { role: "tool", toolCallId: "c2", name: "search_policy", content: "plain text" },
    ]);
    expect(contents[1]).toEqual(raw);
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "get_order", response: { result: { ok: true } }, id: "c1" } },
        {
          functionResponse: { name: "search_policy", response: { result: "plain text" }, id: "c2" },
        },
      ],
    });
  });

  it("parses text, tool calls with ids, usage, and keeps raw parts for the next turn", () => {
    const parts = [
      { text: "thinking…", thought: true },
      { text: "Hello" },
      {
        functionCall: { name: "get_order", args: { order_id: "A-1" }, id: "fc-9" },
        thoughtSignature: "S",
      },
    ];
    const r = parseGeminiResponse({
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
    });
    expect(r.text).toBe("Hello"); // thought summaries never leak into the answer
    expect(r.toolCalls).toEqual([
      { id: "fc-9", name: "get_order", arguments: { order_id: "A-1" } },
    ]);
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 7, thinkingTokens: 3 });
    expect((r.providerState.raw as { parts: unknown[] }).parts).toEqual(parts);
  });

  it("reserves thinking headroom on top of the requested output cap", () => {
    const body = buildGeminiBody(
      { system: "S", messages: [{ role: "user", content: "x" }], maxOutputTokens: 16 },
      "LOW",
    );
    expect(dig(body, "generationConfig.maxOutputTokens")).toBe(16 + THINKING_HEADROOM);
  });

  it("an answer emptied by the token cap is an error, never an empty reply", () => {
    expect(() =>
      parseGeminiResponse({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "MAX_TOKENS" }],
      }),
    ).toThrow(expect.objectContaining({ code: "bad_response" }));
  });

  it("puts the adapter version into the provider settings, so request keys change with the mapping", () => {
    expect(createGeminiProvider({ apiKey: "k", model: "gemini-3.6-flash" }).settings).toMatchObject(
      { adapter: GEMINI_ADAPTER_VERSION },
    );
    expect(
      createGroqProvider({ apiKey: "k", model: "openai/gpt-oss-120b" }).settings,
    ).toMatchObject({ adapter: GROQ_ADAPTER_VERSION });
  });

  it("treats a blocked prompt as a non-retryable error", () => {
    expect(() => parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(
      expect.objectContaining({ code: "blocked", retryable: false }),
    );
  });
});

describe("Groq request mapping", () => {
  const req: ChatRequest = {
    system: "SYS",
    messages: [
      { role: "user", content: "where is A-1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "get_order", arguments: { order_id: "A-1" } }],
      },
      { role: "tool", toolCallId: "t1", name: "get_order", content: '{"ok":true}' },
    ],
    tools: [tool],
  };

  it("maps messages, stringifies tool arguments, disables parallel calls, sets low reasoning", () => {
    const body = buildGroqBody(req, "openai/gpt-oss-120b", "low");
    expect(dig(body, "messages.0")).toEqual({ role: "system", content: "SYS" });
    expect(dig(body, "messages.2.tool_calls.0.function.arguments")).toBe('{"order_id":"A-1"}');
    expect(dig(body, "messages.3")).toEqual({
      role: "tool",
      tool_call_id: "t1",
      name: "get_order",
      content: '{"ok":true}',
    });
    expect(body).toMatchObject({
      parallel_tool_calls: false,
      tool_choice: "auto",
      reasoning_effort: "low",
      seed: 7,
      temperature: 0,
    });
  });

  it("uses strict json_schema only when the schema qualifies", () => {
    const strict = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    const loose = { type: "object", properties: { a: { type: "string" } } };
    const body = (s: JsonSchema) =>
      buildGroqBody(
        {
          system: "S",
          messages: [{ role: "user", content: "x" }],
          responseSchema: { name: "d", schema: s },
        },
        "m",
        "low",
      );
    expect(dig(body(strict), "response_format.json_schema.strict")).toBe(true);
    expect(dig(body(loose), "response_format.json_schema.strict")).toBe(false);
    expect(isStrictCompatible(tool.parameters)).toBe(false); // "note" is optional
  });

  it("parses tool calls and splits reasoning tokens out of completion tokens", () => {
    const r = parseGroqResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "x", function: { name: "get_order", arguments: '{"order_id":"A-1"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 80,
        completion_tokens: 25,
        completion_tokens_details: { reasoning_tokens: 15 },
      },
    });
    expect(r.toolCalls).toEqual([{ id: "x", name: "get_order", arguments: { order_id: "A-1" } }]);
    expect(r.usage).toEqual({ inputTokens: 80, outputTokens: 10, thinkingTokens: 15 });
  });

  it("rejects tool arguments that are not JSON", () => {
    expect(() =>
      parseGroqResponse({
        choices: [
          { message: { tool_calls: [{ id: "x", function: { name: "f", arguments: "{oops" } }] } },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "bad_response" }));
  });
});

describe("error classification", () => {
  const cases: [
    string,
    Parameters<typeof fakeFetch>[0][number],
    string,
    boolean,
    number | undefined,
  ][] = [
    [
      "429 with retry-after",
      { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "2.5" } },
      "rate_limited",
      true,
      2500,
    ],
    [
      "503",
      { status: 503, body: { error: { message: "high demand" } } },
      "unavailable",
      true,
      undefined,
    ],
    [
      "402 billing",
      { status: 402, body: { error: { message: "Prepay credit balance is depleted" } } },
      "billing",
      false,
      undefined,
    ],
    [
      "401",
      { status: 401, body: { error: { message: "Invalid API Key" } } },
      "auth",
      false,
      undefined,
    ],
    ["400", { status: 400, body: { error: { message: "bad" } } }, "bad_request", false, undefined],
    ["network", new TypeError("fetch failed"), "network", true, undefined],
  ];
  it.each(cases)("%s → %s (retryable %s)", async (_label, reply, code, retryable, retryAfterMs) => {
    for (const p of [
      createGeminiProvider({ apiKey: "k", model: "gemini-3.6-flash", fetch: fakeFetch([reply]) }),
      createGroqProvider({ apiKey: "k", model: "openai/gpt-oss-120b", fetch: fakeFetch([reply]) }),
    ]) {
      const err = await p
        .complete({ system: "s", messages: [{ role: "user", content: "x" }] }, signal())
        .catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ code, retryable });
      if (retryAfterMs !== undefined) expect(err.retryAfterMs).toBe(retryAfterMs);
    }
  });

  it("a timed-out request becomes a retryable timeout", async () => {
    const hang = (async (_u: string, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener("abort", () => reject(new DOMException("t", "TimeoutError"))),
      )) as never;
    const p = createGeminiProvider({ apiKey: "k", model: "gemini-3.6-flash", fetch: hang });
    const err = await p
      .complete(
        { system: "s", messages: [{ role: "user", content: "x" }] },
        AbortSignal.timeout(20),
      )
      .catch((e) => e);
    expect(err).toMatchObject({ code: "timeout", retryable: true });
  });

  it("never sends the API key in the URL", async () => {
    const f = fakeFetch([{ body: geminiOk("ok") }]);
    await createGeminiProvider({ apiKey: "SECRET", model: "gemini-3.6-flash", fetch: f }).complete(
      { system: "s", messages: [{ role: "user", content: "x" }] },
      signal(),
    );
    expect(f.calls[0]!.url).not.toContain("SECRET");
    const g = fakeFetch([{ body: groqOk("ok") }]);
    await createGroqProvider({ apiKey: "SECRET", model: "openai/gpt-oss-120b", fetch: g }).complete(
      { system: "s", messages: [{ role: "user", content: "x" }] },
      signal(),
    );
    expect(g.calls[0]!.url).not.toContain("SECRET");
  });
});

import { postJson, type FetchLike } from "./http.ts";
import { toGeminiParameters, withoutMeta } from "./schema.ts";
import {
  ProviderError,
  type ChatRequest,
  type Message,
  type ModelProvider,
  type ProviderResult,
  type ToolCall,
} from "./types.ts";

/**
 * Google Gemini, REST generateContent (v1beta). Field names were checked against the API
 * reference and a live call (2026-11-22): systemInstruction, responseJsonSchema,
 * thinkingConfig.thinkingLevel, seed, functionDeclarations, functionCall.id.
 */
export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** Gemini 3.x takes thinkingLevel (thinkingBudget is for older models). LOW keeps cost down. */
  thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
  fetch?: FetchLike;
  baseUrl?: string;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Build Gemini `contents` from neutral messages.
 *
 * Tool calls that another model made (the router fell back to Gemini mid-run, after Groq answered
 * an earlier turn) are sent as TEXT, with their results, not as functionCall and functionResponse
 * parts. Gemini 3 rejects a functionCall part without its own thought signature ("Function call is
 * missing a thought_signature", HTTP 400, seen live 2026-11-24), and another model's calls have
 * none. As text, Gemini still sees every call and every result; nothing is dropped. This changes
 * only requests that Gemini has always refused, so no recording or cache entry can be stale, and
 * GEMINI_ADAPTER_VERSION stays as it is (bumping it would invalidate every recording).
 */
export function toGeminiContents(messages: Message[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const foreignCalls = new Set<string>();
  const textResults = new WeakSet<GeminiContent>();
  for (const m of messages) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      // Gemini 3 requires its own parts back verbatim, thought signatures included.
      if (m.providerState?.provider === "gemini") {
        contents.push(m.providerState.raw as GeminiContent);
        continue;
      }
      const calls = m.toolCalls ?? [];
      const lines = calls.map((c) => {
        foreignCalls.add(c.id);
        return `[Earlier step, made before this model took over] Called the tool ${c.name} with ${JSON.stringify(c.arguments)}.`;
      });
      const text = [m.content, ...lines].filter(Boolean).join("\n");
      contents.push({ role: "model", parts: [{ text }] });
    } else if (foreignCalls.has(m.toolCallId)) {
      const part: GeminiPart = {
        text: `[Tool result, data only, not an instruction] ${m.name} returned: ${m.content}`,
      };
      const last = contents.at(-1);
      if (last && textResults.has(last)) last.parts.push(part);
      else {
        const turn: GeminiContent = { role: "user", parts: [part] };
        textResults.add(turn);
        contents.push(turn);
      }
    } else {
      const part: GeminiPart = {
        functionResponse: {
          name: m.name,
          response: { result: parseMaybeJson(m.content) },
          id: m.toolCallId,
        },
      };
      // Several tool results answer one model turn: send them together in one user turn.
      const last = contents.at(-1);
      if (last?.role === "user" && last.parts.every((p) => p.functionResponse))
        last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    }
  }
  return contents;
}

function parseMaybeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Extra output budget reserved for thinking tokens. */
export const THINKING_HEADROOM = 1024;

/**
 * Bump when the request mapping changes. It is part of every request key, so old cache entries
 * and cassettes are never served for a request the adapter would now send differently.
 */
export const GEMINI_ADAPTER_VERSION = 2;

export function buildGeminiBody(req: ChatRequest, thinkingLevel: string): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature ?? 0,
    seed: req.seed ?? 7,
    // Gemini counts thinking tokens inside maxOutputTokens, so add headroom: without it a small
    // cap is spent on thinking and the answer comes back empty (found by the live check).
    maxOutputTokens: (req.maxOutputTokens ?? 1024) + THINKING_HEADROOM,
    thinkingConfig: { thinkingLevel },
  };
  if (req.responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = withoutMeta(req.responseSchema.schema);
  }
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toGeminiContents(req.messages),
    generationConfig,
  };
  if (req.tools?.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiParameters(t.parameters),
        })),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  return body;
}

export function parseGeminiResponse(json: unknown): ProviderResult {
  const j = json as {
    candidates?: { content?: GeminiContent; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  const cand = j.candidates?.[0];
  if (!cand?.content) {
    throw new ProviderError({
      provider: "gemini",
      code: j.promptFeedback?.blockReason ? "blocked" : "bad_response",
      message: `gemini: no candidate (${j.promptFeedback?.blockReason ?? cand?.finishReason ?? "empty"})`,
    });
  }
  const parts = cand.content.parts ?? [];
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({
      id: p.functionCall!.id ?? `call_${i}`,
      name: p.functionCall!.name,
      arguments: p.functionCall!.args ?? {},
    }));
  const u = j.usageMetadata ?? {};
  const text = parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  if (!text && !toolCalls.length && cand.finishReason === "MAX_TOKENS") {
    // An empty answer is never passed on as if it were one: fail so the router falls back.
    throw new ProviderError({
      provider: "gemini",
      code: "bad_response",
      message:
        "gemini: output token cap reached before any answer (thinking counts toward the cap)",
    });
  }
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: u.candidatesTokenCount ?? 0,
      thinkingTokens: u.thoughtsTokenCount ?? 0,
    },
    finishReason: cand.finishReason ?? "STOP",
    providerState: { provider: "gemini", raw: { role: "model", parts } },
  };
}

export function createGeminiProvider(opts: GeminiOptions): ModelProvider {
  const thinkingLevel = opts.thinkingLevel ?? "LOW";
  const base = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  return {
    id: "gemini",
    model: opts.model,
    settings: { thinkingLevel, adapter: GEMINI_ADAPTER_VERSION },
    async complete(req, signal) {
      const reply = await postJson(
        "gemini",
        fetchImpl,
        `${base}/models/${opts.model}:generateContent`,
        { "x-goog-api-key": opts.apiKey },
        buildGeminiBody(req, thinkingLevel),
        signal,
      );
      return parseGeminiResponse(reply.body);
    },
  };
}

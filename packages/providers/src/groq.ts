import { postJson, type FetchLike } from "./http.ts";
import { isStrictCompatible, withoutMeta } from "./schema.ts";
import {
  ProviderError,
  type ChatRequest,
  type ModelProvider,
  type ProviderResult,
  type ToolCall,
} from "./types.ts";

/**
 * Groq, OpenAI-compatible chat completions. Checked against Groq's docs and a live call
 * (2026-11-22): tools with stringified arguments, role "tool" results, response_format
 * json_schema (strict on gpt-oss-120b, never together with tools), reasoning_effort, seed.
 */
export interface GroqOptions {
  apiKey: string;
  model: string;
  /** gpt-oss reasoning effort. "low" keeps tokens and latency down. */
  reasoningEffort?: "low" | "medium" | "high";
  fetch?: FetchLike;
  baseUrl?: string;
}

/** Bump when the request mapping changes; part of every request key (see gemini.ts). */
export const GROQ_ADAPTER_VERSION = 1;

export function buildGroqBody(
  req: ChatRequest,
  model: string,
  reasoningEffort: string,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "user") messages.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant", content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        }));
      }
      messages.push(msg);
    } else {
      messages.push({ role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content });
    }
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: req.temperature ?? 0,
    seed: req.seed ?? 7,
    max_tokens: (req.maxOutputTokens ?? 1024) + 1024, // headroom for reasoning tokens, which count here
    reasoning_effort: reasoningEffort,
    include_reasoning: false,
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: withoutMeta(t.parameters) },
    }));
    body.tool_choice = "auto";
    body.parallel_tool_calls = false; // not supported on gpt-oss-120b per Groq's tool-use docs
  }
  if (req.responseSchema) {
    const schema = withoutMeta(req.responseSchema.schema);
    body.response_format = {
      type: "json_schema",
      json_schema: { name: req.responseSchema.name, schema, strict: isStrictCompatible(schema) },
    };
  }
  return body;
}

export function parseGroqResponse(json: unknown): ProviderResult {
  const j = json as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
      finish_reason?: string;
    }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const choice = j.choices?.[0];
  if (!choice?.message) {
    throw new ProviderError({
      provider: "groq",
      code: "bad_response",
      message: "groq: no choice in response",
    });
  }
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((c) => {
    let args: unknown;
    try {
      args = JSON.parse(c.function.arguments || "{}");
    } catch {
      throw new ProviderError({
        provider: "groq",
        code: "bad_response",
        message: `groq: tool ${c.function.name} sent arguments that are not JSON`,
      });
    }
    return { id: c.id, name: c.function.name, arguments: (args ?? {}) as Record<string, unknown> };
  });
  const u = j.usage ?? {};
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    text: choice.message.content ?? "",
    toolCalls,
    // OpenAI-style completion_tokens already include reasoning; split them so output is visible text only.
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: Math.max(0, (u.completion_tokens ?? 0) - reasoning),
      thinkingTokens: reasoning,
    },
    finishReason: choice.finish_reason ?? "stop",
    providerState: { provider: "groq", raw: null },
  };
}

export function createGroqProvider(opts: GroqOptions): ModelProvider {
  const reasoningEffort = opts.reasoningEffort ?? "low";
  const base = opts.baseUrl ?? "https://api.groq.com/openai/v1";
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  return {
    id: "groq",
    model: opts.model,
    settings: { reasoningEffort, adapter: GROQ_ADAPTER_VERSION },
    async complete(req, signal) {
      const reply = await postJson(
        "groq",
        fetchImpl,
        `${base}/chat/completions`,
        { authorization: `Bearer ${opts.apiKey}` },
        buildGroqBody(req, opts.model, reasoningEffort),
        signal,
      );
      return parseGroqResponse(reply.body);
    },
  };
}

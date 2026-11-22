/**
 * Provider-neutral chat types. The agent speaks only these; adapters translate to and from
 * each vendor's wire format.
 */

export type JsonSchema = Record<string, unknown>;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Opaque vendor data that must be sent back verbatim on the next turn (e.g. Gemini thought signatures). */
export interface ProviderState {
  provider: ProviderId;
  raw: unknown;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; providerState?: ProviderState }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * One model call. A request either offers tools OR asks for a schema-shaped answer, never
 * both: Groq does not support structured outputs together with tool use, and keeping the two
 * apart makes every request portable across providers (and matches the agent's states:
 * gather facts with tools, then decide with a schema).
 */
export interface ChatRequest {
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  responseSchema?: { name: string; schema: JsonSchema };
  /** Visible output cap. Defaults to 1024. */
  maxOutputTokens?: number;
  /** Defaults to 0 (as deterministic as the provider allows). */
  temperature?: number;
  /** Defaults to 7. Providers treat it as best effort. */
  seed?: number;
}

export interface Usage {
  inputTokens: number;
  /** Visible output tokens, excluding reasoning. */
  outputTokens: number;
  /** Reasoning ("thinking") tokens. Billed as output by both providers. */
  thinkingTokens: number;
}

export type ProviderId = "gemini" | "groq";

/** What an adapter returns for one successful call. */
export interface ProviderResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string;
  providerState: ProviderState;
}

export interface ModelProvider {
  readonly id: ProviderId;
  readonly model: string;
  /** Settings that change the answer (thinking level etc.); part of every request key. */
  readonly settings: Record<string, unknown>;
  complete(req: ChatRequest, signal: AbortSignal): Promise<ProviderResult>;
}

export type ResponseSource = "live" | "cache" | "cassette";

export interface Attempt {
  provider: ProviderId;
  model: string;
  ok: boolean;
  status?: number;
  code?: string;
  ms: number;
}

/** What the router returns. */
export interface ChatResponse extends ProviderResult {
  provider: ProviderId;
  model: string;
  /** Where the answer came from. Only "live" spent a real API call. */
  source: ResponseSource;
  /** Content-addressed request key (sha256). */
  key: string;
  /** Equivalent cost at the model's paid list price; actual spend on the free tier is $0. */
  listPriceUsd: number;
  /** Time the provider(s) took, retries and backoff included, but NOT our own pacing wait. */
  latencyMs: number;
  /** Time spent waiting on the free-tier pacing (UsageLedger) before calling. Never model latency. */
  waitMs: number;
  /** For answers served from a cassette: the provider latency measured when it was recorded. */
  recordedLatencyMs?: number;
  attempts: Attempt[];
}

export type ProviderErrorCode =
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "network"
  | "auth"
  | "billing"
  | "bad_request"
  | "blocked"
  | "bad_response";

/** A failed call, classified so the router can decide: retry, fall back, or stop. */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly code: ProviderErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  constructor(init: {
    provider: ProviderId;
    code: ProviderErrorCode;
    message: string;
    status?: number;
    retryAfterMs?: number;
  }) {
    super(init.message);
    this.name = "ProviderError";
    this.provider = init.provider;
    this.code = init.code;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    // Retrying only helps when the problem is transient. Auth, billing (Gemini 402: "won't
    // succeed until credits are added") and malformed requests never get better by repeating.
    this.retryable = ["rate_limited", "unavailable", "timeout", "network"].includes(init.code);
  }
}

/** Map an HTTP status to an error code. Shared by both adapters. */
export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 408) return "timeout";
  if (status >= 500) return "unavailable";
  return "bad_request";
}

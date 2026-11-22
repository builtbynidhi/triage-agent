import { createSqliteStore, openDb, seed, SEED_TODAY } from "@triage/data";
import type { ChatRequest, ChatResponse, ToolCall } from "@triage/providers";
import type { Decision } from "./decision.ts";
import { connectTools } from "./tools.ts";

/** Real MCP tools over the real protocol, on a seeded in-memory database (keyword retrieval). */
export async function seededTools(tenantId = "tenant_a") {
  const db = openDb(":memory:");
  seed(db);
  return connectTools({ store: createSqliteStore(db), tenantId, today: SEED_TODAY });
}

export function reply(
  r: { text?: string; toolCalls?: ToolCall[]; tokens?: number } = {},
): ChatResponse {
  return {
    text: r.text ?? "",
    toolCalls: r.toolCalls ?? [],
    usage: { inputTokens: r.tokens ?? 500, outputTokens: 50, thinkingTokens: 0 },
    finishReason: "STOP",
    providerState: { provider: "groq", raw: null },
    provider: "gemini",
    model: "gemini-3.6-flash",
    source: "cassette",
    key: "test",
    listPriceUsd: 0.0001,
    latencyMs: 1,
    waitMs: 0,
    attempts: [],
  };
}

export const decisionText = (d: Partial<Decision>): string =>
  JSON.stringify({
    decision: "AUTO_REPLY",
    intent: "return_request",
    confidence: 0.9,
    facts_used: [],
    clause_ids: [],
    reply_draft: "",
    escalation_reason: "",
    missing_fields: [],
    ...d,
  });

/** A model that plays a script, one entry per call, and records every request it gets. */
export function scriptedRouter(script: (ChatResponse | Error)[]) {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async complete(req: ChatRequest): Promise<ChatResponse> {
      requests.push(structuredClone(req));
      const next = script[requests.length - 1];
      if (!next) throw new Error(`scriptedRouter: no reply scripted for call ${requests.length}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

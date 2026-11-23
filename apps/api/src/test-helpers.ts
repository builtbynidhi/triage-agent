import {
  createJobQueue,
  createRunStore,
  createSqliteStore,
  openDb,
  seed,
  SEED_TODAY,
  type JobQueue,
  type RunStore,
  type TriageStore,
} from "@triage/data";
import type { ChatRequest, ChatResponse, ToolCall } from "@triage/providers";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.ts";
import { signToken, type Role } from "./auth.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { createWorker } from "./worker.ts";

export const SECRET = "test-secret-".padEnd(48, "x");

/** A model reply. Same shape the agent's own tests use. */
export function reply(r: { text?: string; toolCalls?: ToolCall[] } = {}): ChatResponse {
  return {
    text: r.text ?? "",
    toolCalls: r.toolCalls ?? [],
    usage: { inputTokens: 500, outputTokens: 50, thinkingTokens: 0 },
    finishReason: "STOP",
    providerState: { provider: "groq", raw: null },
    provider: "groq",
    model: "openai/gpt-oss-120b",
    source: "cassette",
    key: "test",
    listPriceUsd: 0.0001,
    latencyMs: 1,
    waitMs: 0,
    attempts: [],
  };
}
export const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});
export const decisionText = (d: Record<string, unknown>) =>
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

/** A model that plays a script, one entry per call, and fails if it runs out. */
export function scriptedRouter(script: (ChatResponse | Error)[]) {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async complete(req: ChatRequest): Promise<ChatResponse> {
      requests.push(structuredClone(req));
      const next = script[requests.length - 1];
      if (!next) throw new Error("scriptedRouter: no reply scripted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** The script for a sealed return of order A-10413: search, look up, check eligibility, then a reply. */
export const returnScript = () => [
  reply({
    toolCalls: [
      call("c1", "search_policy", { query: "return window for a sealed item" }),
      call("c2", "get_order", { order_id: "A-10413" }),
      call("c3", "check_eligibility", { order_id: "A-10413", request_type: "return" }),
    ],
  }),
  reply({ text: "DONE" }),
  reply({
    text: decisionText({
      clause_ids: ["returns.window"],
      reply_draft: "Yes, you can return it within the 7-day window; we will arrange a free pickup.",
      facts_used: ["order.delivered_at"],
    }),
  }),
];
export const RETURN_TICKET = {
  text: "Got my blender on 13th nov, still sealed, want to return it. Order A-10413",
  channel: "email",
};

/** Written out, so the helper never has to name the database driver's types. */
export interface TestApi {
  count(table: string): number;
  store: TriageStore;
  runs: RunStore;
  queue: JobQueue;
  clock: { now: Date };
  base: string;
  token(role: Role, tenantId?: string, sub?: string): Promise<string>;
  api(
    method: string,
    path: string,
    who: Promise<string> | string | null,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; headers: Headers; json: Record<string, any> | null; text: string }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  worker(router: ReturnType<typeof scriptedRouter>): ReturnType<typeof createWorker>;
  close(): Promise<void>;
}

/** A real Express server on a free port, over an in-memory seeded database. */
export async function startTestApi(
  opts: { capacity?: number; refillPerSec?: number; maxStreams?: number } = {},
) {
  const db = openDb(":memory:");
  seed(db);
  const clock = { now: new Date("2026-11-20T06:00:00.000Z") };
  const store = createSqliteStore(db);
  const runs = createRunStore(db, { now: () => clock.now });
  const queue = createJobQueue(db, { now: () => clock.now, backoffMs: (n) => n * 1000 });
  const limiter = createRateLimiter({
    capacity: opts.capacity ?? 100,
    refillPerSec: opts.refillPerSec ?? 100,
    now: () => clock.now.getTime(),
  });
  const app = createApp({
    store,
    runs,
    jwtSecret: SECRET,
    limiter,
    today: SEED_TODAY,
    pollMs: 15,
    maxStreamsPerTenant: opts.maxStreams ?? 10,
  });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (role: Role, tenantId = "tenant_a", sub = `${role}_1`) =>
    signToken(SECRET, { sub, tenantId, role });
  const api = async (
    method: string,
    path: string,
    who: Promise<string> | string | null,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(who ? { Authorization: `Bearer ${await who}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? safeJson(text) : null, text };
  };
  const worker = (router: ReturnType<typeof scriptedRouter>) =>
    createWorker({ store, runs, queue, router, today: () => SEED_TODAY });
  return {
    count: (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    store,
    runs,
    queue,
    clock,
    base,
    token,
    api,
    worker,
    close: () =>
      new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
const safeJson = (t: string) => {
  try {
    // Responses are untrusted JSON of many shapes; the tests assert on what they need.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return JSON.parse(t) as Record<string, any>;
  } catch {
    return null;
  }
};

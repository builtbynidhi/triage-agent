import type { FetchLike } from "./http.ts";
import type { Clock } from "./ledger.ts";

/** A scripted fetch: each call takes the next reply. Records every request it was sent. */
export function fakeFetch(
  replies: ({ status?: number; body?: unknown; headers?: Record<string, string> } | Error)[],
): FetchLike & { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (!r) throw new Error("fakeFetch: no scripted reply");
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: r.headers,
    });
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

/** A clock that only moves when something sleeps, and records every sleep. */
export function fakeClock(start = Date.parse("2026-11-22T06:00:00Z")): Clock & { slept: number[] } {
  let t = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    async sleep(ms) {
      slept.push(ms);
      t += ms;
    },
  };
}

export const geminiOk = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10 },
  ...extra,
});

export const groqOk = (text: string) => ({
  choices: [{ message: { content: text }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 30,
    completion_tokens_details: { reasoning_tokens: 10 },
  },
});

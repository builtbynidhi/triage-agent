import { ProviderError, codeForResponse, type ProviderId } from "./types.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonReply {
  status: number;
  headers: Headers;
  body: unknown;
}

/** POST JSON and return the parsed reply, or throw a classified ProviderError. */
export async function postJson(
  provider: ProviderId,
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<JsonReply> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const aborted =
      signal.aborted ||
      (err as Error).name === "TimeoutError" ||
      (err as Error).name === "AbortError";
    throw new ProviderError({
      provider,
      code: aborted ? "timeout" : "network",
      message: aborted ? `${provider}: request timed out` : `${provider}: network error`,
    });
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    const message = errorMessage(parsed) ?? `HTTP ${res.status}`;
    throw new ProviderError({
      provider,
      code: codeForResponse(res.status, message),
      status: res.status,
      message: `${provider}: ${message}`,
      retryAfterMs: retryAfterMs(res.headers),
    });
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

function errorMessage(body: unknown): string | undefined {
  const e = (body as { error?: { message?: unknown } })?.error;
  return typeof e?.message === "string" ? e.message.slice(0, 300) : undefined;
}

/** `retry-after` in seconds (Groq sends it on 429). Gemini sends none; the router backs off itself. */
function retryAfterMs(headers: Headers): number | undefined {
  const v = headers.get("retry-after");
  if (!v) return undefined;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : undefined;
}

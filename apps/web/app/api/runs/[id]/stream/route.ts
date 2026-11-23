import { apiFetch, getMode } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * Follows a running run for the browser. The API needs a token, and the token must never reach the
 * browser, so this route fetches the stream server-side and passes it through. Live mode only.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (getMode() !== "live") return new Response("Live view needs the API.", { status: 404 });
  const { id } = await ctx.params;
  if (!/^run_[0-9a-f]+$/.test(id)) return new Response("Not found.", { status: 404 });
  const upstream = await apiFetch(`/v1/runs/${id}/stream`, { signal: request.signal });
  if (!upstream.ok || !upstream.body)
    return new Response("The API could not be reached.", { status: 502 });
  return new Response(upstream.body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
  });
}

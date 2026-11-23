import snapshotJson from "../data/snapshot.json";
import type { ApprovalView, RunDetail, RunSummary, ScorecardData, Snapshot } from "./types";

/**
 * Where the pages get their data, in one place.
 *
 *   snapshot (default)  data/snapshot.json: a read-only copy of real runs. Needs nothing else, so
 *                       it deploys to Vercel, which cannot load the live system's SQLite code.
 *   live                set TRIAGE_API_URL and TRIAGE_API_TOKEN (a reviewer token): the pages read
 *                       the Express API. The token stays on the server; the browser never sees it.
 *
 * Both return the same shapes (lib/types.ts), so no page knows which one it is using.
 */
const snapshot = snapshotJson as unknown as Snapshot;

export type Mode = "snapshot" | "live";

export const getMode = (): Mode => (process.env.TRIAGE_API_URL ? "live" : "snapshot");

/**
 * May the UI approve and reject? Only in live mode, and only when the operator opts in. This app
 * has no login of its own: with a reviewer token on the server, anyone who can reach it would act as
 * that reviewer. Set TRIAGE_WEB_ALLOW_APPROVE=true only on a machine you trust (localhost).
 */
export const approvalsEnabled = (): boolean =>
  getMode() === "live" && process.env.TRIAGE_WEB_ALLOW_APPROVE === "true";

function apiConfig() {
  const base = process.env.TRIAGE_API_URL;
  const token = process.env.TRIAGE_API_TOKEN;
  if (!base || !token) throw new Error("Live mode needs TRIAGE_API_URL and TRIAGE_API_TOKEN.");
  return { base: base.replace(/\/$/, ""), token };
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { base, token } = apiConfig();
  return fetch(`${base}${path}`, {
    cache: "no-store",
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
}

async function apiJson<T>(path: string): Promise<T | null> {
  const res = await apiFetch(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The API answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** The list view of a run: everything except the heavy parts (result, steps, trace, approvals). */
const summary = (r: RunDetail): RunSummary => ({
  id: r.id,
  status: r.status,
  decision: r.decision,
  ticket: r.ticket,
  usage: r.usage,
  latency_ms: r.latency_ms,
  failure: r.failure,
  created_at: r.created_at,
  finished_at: r.finished_at,
  ...(r.case_id ? { case_id: r.case_id } : {}),
  ...(r.category ? { category: r.category } : {}),
});

export async function listRuns(): Promise<RunSummary[]> {
  if (getMode() === "snapshot") return snapshot.runs.map(summary);
  return (await apiJson<{ runs: RunSummary[] }>("/v1/runs?limit=200"))?.runs ?? [];
}

export async function getRun(id: string): Promise<RunDetail | null> {
  if (getMode() === "snapshot") return snapshot.runs.find((r) => r.id === id) ?? null;
  return apiJson<RunDetail>(`/v1/runs/${encodeURIComponent(id)}`);
}

export type QueueItem = ApprovalView & { run: RunSummary | null };

/** The approval queue: every approval, newest first, with its run alongside. */
export async function listApprovals(status?: ApprovalView["status"]): Promise<QueueItem[]> {
  if (getMode() === "snapshot") {
    return snapshot.runs
      .flatMap((r) => r.approvals.map((a) => ({ ...a, run: summary(r) })))
      .filter((a) => !status || a.status === status);
  }
  const res = await apiJson<{ approvals: ApprovalView[] }>(
    `/v1/approvals?status=${status ?? "pending"}`,
  );
  const runs = new Map((await listRuns()).map((r) => [r.id, r]));
  return (res?.approvals ?? []).map((a) => ({ ...a, run: runs.get(a.run_id) ?? null }));
}

/** The scorecard is the eval report: the same in both modes (it comes from evals/report/report.json). */
export const getScorecard = (): ScorecardData => snapshot.scorecard;

export const getSnapshotInfo = () => ({
  generatedAt: snapshot.generated_at,
  note: snapshot.note,
  skipped: snapshot.skipped,
  runCount: snapshot.runs.length,
});

/** Run IDs to prerender. Live runs are rendered on request instead. */
export const staticRunIds = (): string[] =>
  getMode() === "snapshot" ? snapshot.runs.map((r) => r.id) : [];

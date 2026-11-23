/**
 * pnpm web:snapshot
 *
 * Builds apps/web/data/snapshot.json: the data behind the PUBLIC demo.
 *
 * Why a snapshot: the live system keeps its runs in SQLite (better-sqlite3 with FTS5 and
 * sqlite-vec), native code that Vercel's serverless runtime cannot load. So the public demo is a
 * read-only, static copy of real runs.
 *
 * Where the runs come from: every eval ticket that has a committed recording is put through the REAL
 * worker (the real agent, real hybrid retrieval, real MCP tools, real spans) with the model replayed
 * from its recording. Nothing is invented and no model is called, so building it costs $0 and makes
 * 0 API calls. A ticket with no recording, and the one case that needs a poisoned policy, are left
 * out and counted in the file's `skipped`.
 *
 * The scorecard page's data is evals/report/report.json, summarised.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDefaultRetriever,
  createJobQueue,
  createRunStore,
  createSqliteStore,
  openDb,
  seed,
  SEED_TODAY,
} from "@triage/data";
import { createDefaultRouter } from "@triage/providers";
import { initTelemetry } from "@triage/telemetry";
// A script, not a library: it reaches into the eval package for the 40 cases and nothing else.
import { loadCases } from "../../../evals/src/load-cases.ts";
import { createWorker } from "./worker.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, "apps", "web", "data", "snapshot.json");

const telemetry = initTelemetry({}); // collect spans in memory only: no files, no OTLP
const db = openDb(":memory:");
seed(db);
const store = createSqliteStore(db);
const runs = createRunStore(db);
const queue = createJobQueue(db);
const worker = createWorker({
  store,
  runs,
  queue,
  router: createDefaultRouter({ mode: "replay" }),
  retriever: createDefaultRetriever(store),
  today: () => SEED_TODAY,
  collector: telemetry.collector,
});

const cases = loadCases().map((c) => c.data);
const skipped: { case_id: string; why: string }[] = [];
const made: { runId: string; caseId: string; category: string }[] = [];
for (const c of cases) {
  if (c.fixtures.planted_policy) {
    skipped.push({
      case_id: c.id,
      why: "needs a poisoned-policy fixture, which only the eval harness sets up",
    });
    continue;
  }
  const { run } = runs.createRun({
    tenantId: c.tenant,
    channel: c.ticket.channel,
    text: c.ticket.text,
    ...(c.ticket.order_id ? { orderId: c.ticket.order_id } : {}),
    maxAttempts: 1, // a ticket with no recording fails once and is left out, not retried
  });
  made.push({ runId: run.id, caseId: c.id, category: c.category });
}
await worker.drain();

const runViews = made.flatMap(({ runId, caseId, category }) => {
  const run = runs.findRun(runId)!;
  if (run.status === "failed") {
    skipped.push({ case_id: caseId, why: "no committed recording for this ticket" });
    return [];
  }
  const tenantId = run.tenantId;
  return [
    {
      id: run.id,
      case_id: caseId,
      category,
      tenant_id: tenantId,
      status: run.status,
      decision: run.decision,
      ticket: { channel: run.ticket.channel, text: run.ticket.text, order_id: run.ticket.orderId },
      usage: {
        input_tokens: run.inputTokens,
        output_tokens: run.outputTokens,
        cost_usd: run.costUsd,
      },
      latency_ms: Math.round(run.latencyMs),
      failure: run.failure,
      created_at: run.createdAt,
      finished_at: run.finishedAt,
      result: run.decisionJson,
      steps: runs.listSteps(tenantId, run.id),
      trace: runs.getTrace(tenantId, run.id) ?? [],
      approvals: runs
        .listApprovals(tenantId)
        .filter((a) => a.runId === run.id)
        .map((a) => ({
          id: a.id,
          run_id: a.runId,
          action: a.action,
          status: a.status,
          payload: a.payload,
          reviewer: a.reviewer,
          created_at: a.createdAt,
          decided_at: a.decidedAt,
        })),
    },
  ];
});

// The scorecard page: the eval report, summarised per case. Numbers are copied, never recomputed.
const report = JSON.parse(readFileSync(join(root, "evals", "report", "report.json"), "utf8")) as {
  meta: Record<string, unknown>;
  scorecard: Record<string, unknown>;
  runs: {
    caseId: string;
    category: string;
    repeat: number;
    complete: boolean;
    incompleteReason?: string;
    grade?: { pass: boolean; reasons: string[] };
  }[];
};
const byCase = new Map<
  string,
  {
    category: string;
    passed: number;
    scored: number;
    reasons: Set<string>;
    incomplete: string | null;
  }
>();
for (const r of report.runs) {
  const e = byCase.get(r.caseId) ?? {
    category: r.category,
    passed: 0,
    scored: 0,
    reasons: new Set<string>(),
    incomplete: null,
  };
  if (r.complete && r.grade) {
    e.scored++;
    if (r.grade.pass) e.passed++;
    else r.grade.reasons.forEach((x) => e.reasons.add(x));
  } else e.incomplete = r.incompleteReason ?? "incomplete";
  byCase.set(r.caseId, e);
}

const snapshot = {
  generated_at: new Date().toISOString(),
  note:
    "Read-only snapshot of real runs. Each ticket was put through the real worker (agent, hybrid retrieval, " +
    "MCP tools, OpenTelemetry spans) with the model replayed from its committed recording: no model was " +
    "called and nothing here is invented. Latencies are the recorded provider latencies.",
  today: SEED_TODAY,
  skipped,
  runs: runViews.sort((a, b) => a.case_id.localeCompare(b.case_id)),
  scorecard: {
    meta: report.meta,
    card: report.scorecard,
    cases: [...byCase.entries()]
      .map(([case_id, e]) => ({
        case_id,
        category: e.category,
        passed: e.passed,
        scored: e.scored,
        reasons: [...e.reasons],
        incomplete: e.incomplete,
      }))
      .sort((a, b) => a.case_id.localeCompare(b.case_id)),
  },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(snapshot) + "\n");
const decided = new Map<string, number>();
for (const r of runViews)
  decided.set(r.decision ?? "none", (decided.get(r.decision ?? "none") ?? 0) + 1);
console.error(
  `snapshot: ${runViews.length} runs (${[...decided].map(([k, v]) => `${k} ${v}`).join(", ")}), ${skipped.length} skipped, ${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB -> ${out}`,
);

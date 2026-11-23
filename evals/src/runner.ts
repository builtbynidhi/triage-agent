import { connectTools, runAgent, loadSystemPrompt, type Ticket } from "@triage/agent";
import {
  createDefaultRetriever,
  createSqliteStore,
  openDb,
  seed,
  SEED_TODAY,
  type TriageStore,
} from "@triage/data";
import {
  CassetteMissError,
  createDefaultRouter,
  type ProviderMode,
  type Router,
} from "@triage/providers";
import type { EvalCase } from "./case-schema.ts";
import { gradeRun } from "./grade.ts";
import type { LoadedCase } from "./load-cases.ts";
import { runLatency, type ScoredRun } from "./metrics.ts";

/**
 * Drives each case through the same entry point a real ticket uses: the agent, the MCP server,
 * hybrid retrieval and the router. The harness only supplies the ticket, the tenant and the
 * fixed date, so it grades the system, not a special test path.
 */
export interface SuiteOptions {
  cases: LoadedCase[];
  repeats: number;
  mode: ProviderMode;
  router?: Pick<Router, "complete">;
  /** Never call the fallback provider (recording runs). Replay is unaffected. */
  primaryOnly?: boolean;
  onProgress?: (line: string) => void;
}

function seededStore(): TriageStore {
  const db = openDb(":memory:");
  seed(db);
  return createSqliteStore(db);
}

/**
 * The poisoned-policy fixture: a fake clause added to retrieval for one case only, scoped to
 * that case's tenant, in its own database. It never touches policies/ or the shared seed, and
 * real hybrid retrieval decides whether it surfaces (CLAUDE.md, "Decisions on the decision contract").
 */
function storeWithPlantedPolicy(c: EvalCase): TriageStore {
  const db = openDb(":memory:");
  seed(db);
  const p = c.fixtures.planted_policy!;
  db.prepare(
    "INSERT INTO policy_chunks (clause_id, doc, title, text, tenant_id) VALUES (?, ?, ?, ?, ?)",
  ).run(p.clause_id, p.clause_id.split(".")[0], p.title, p.text, c.tenant);
  db.prepare("INSERT INTO policy_fts (clause_id, title, text) VALUES (?, ?, ?)").run(
    p.clause_id,
    p.title,
    p.text,
  );
  return createSqliteStore(db);
}

export async function runSuite(opts: SuiteOptions): Promise<ScoredRun[]> {
  const router =
    opts.router ??
    createDefaultRouter({ mode: opts.mode, ...(opts.primaryOnly ? { primaryOnly: true } : {}) });
  const shared = seededStore();
  const sharedRetriever = createDefaultRetriever(shared);
  const runs: ScoredRun[] = [];

  for (const { data: c } of opts.cases) {
    const planted = !!c.fixtures.planted_policy;
    const store = planted ? storeWithPlantedPolicy(c) : shared;
    const retriever = planted ? createDefaultRetriever(store) : sharedRetriever;
    const tools = await connectTools({ store, tenantId: c.tenant, today: SEED_TODAY, retriever });
    const ticket: Ticket = {
      text: c.ticket.text,
      channel: c.ticket.channel,
      ...(c.ticket.order_id ? { orderId: c.ticket.order_id } : {}),
    };
    try {
      for (let repeat = 1; repeat <= opts.repeats; repeat++) {
        const base = { caseId: c.id, category: c.category, repeat };
        try {
          const result = await runAgent({ ticket, tools, router, today: SEED_TODAY });
          if (result.exit === "provider_error") {
            runs.push({
              ...base,
              complete: false,
              incompleteReason: result.exitReason ?? "provider error",
              result,
            });
          } else {
            runs.push({
              ...base,
              complete: true,
              grade: gradeRun(c, result),
              result,
              latencyMs: runLatency(result),
            });
          }
        } catch (err) {
          if (!(err instanceof CassetteMissError)) throw err;
          runs.push({
            ...base,
            complete: false,
            incompleteReason: "no recording (run with --mode record-missing)",
          });
          break; // the other repeats would miss the same recording
        }
        const last = runs.at(-1)!;
        opts.onProgress?.(
          `${c.id} #${repeat}: ${last.complete ? `${last.grade!.pass ? "PASS" : "FAIL"} (${last.result!.decision.decision})` : `INCOMPLETE: ${last.incompleteReason}`}`,
        );
      }
    } finally {
      await tools.close();
    }
  }
  return runs;
}

export function suiteMeta(mode: ProviderMode, repeats: number) {
  const p = loadSystemPrompt();
  return {
    date: new Date().toISOString().slice(0, 10),
    mode,
    repeats,
    today: SEED_TODAY,
    prompt: { version: p.version, hash: p.hash },
  };
}

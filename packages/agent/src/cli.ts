/**
 *   pnpm agent:run --ticket "I got the blender on 18 Nov, still sealed. Can I return it? Order A-10410"
 *
 * Options:
 *   --tenant tenant_a|tenant_b   merchant (default tenant_a)
 *   --channel email|chat|web|voice
 *   --order-id A-10410           when the channel supplies it separately
 *   --mode replay|record-missing|record|live   overrides PROVIDER_MODE (default replay)
 *   --demo                       use data/demo.db and today's real date (default: the fixed
 *                                seed database and its date 2026-11-20, so runs replay exactly)
 *   --json                       print only the full JSON result
 *
 * Replay (the default) makes no API calls; a ticket that was never recorded fails with
 * instructions. Record a new ticket once with --mode record-missing.
 */
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  createDefaultRetriever,
  createSqliteStore,
  defaultDbPath,
  openDb,
  SEED_TODAY,
} from "@triage/data";
import {
  CassetteMissError,
  createDefaultRouter,
  MODES,
  type ProviderMode,
} from "@triage/providers";
import { runAgent } from "./machine.ts";
import { connectTools } from "./tools.ts";
import type { Ticket } from "./ticket.ts";

const { values } = parseArgs({
  options: {
    ticket: { type: "string" },
    tenant: { type: "string", default: "tenant_a" },
    channel: { type: "string", default: "email" },
    "order-id": { type: "string" },
    mode: { type: "string" },
    demo: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

if (!values.ticket) {
  console.error(
    'usage: pnpm agent:run --ticket "<ticket text>" [--tenant tenant_a] [--mode replay|record-missing|live] [--demo] [--json]',
  );
  process.exit(1);
}
if (values.mode && !(MODES as readonly string[]).includes(values.mode)) {
  console.error(`--mode must be one of ${MODES.join(", ")}`);
  process.exit(1);
}

const dbPath = values.demo ? join(dirname(defaultDbPath()), "demo.db") : defaultDbPath();
const today = values.demo
  ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())
  : SEED_TODAY;
const store = createSqliteStore(openDb(dbPath));
const tools = await connectTools({
  store,
  tenantId: values.tenant!,
  today,
  retriever: createDefaultRetriever(store),
});
const router = createDefaultRouter(values.mode ? { mode: values.mode as ProviderMode } : {});
const ticket: Ticket = {
  text: values.ticket,
  channel: values.channel as Ticket["channel"],
  ...(values["order-id"] ? { orderId: values["order-id"] } : {}),
};

try {
  const result = await runAgent({ ticket, tools, router, today });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `\nDecision (${result.exit}, ${result.status}${result.repaired ? ", repaired once" : ""}${result.downgraded ? ", downgraded for low confidence" : ""}):`,
    );
    console.log(JSON.stringify(result.decision, null, 2));
    console.log(
      `\nProposal (needs human approval): ${result.proposal ? result.proposal.action : "none"}`,
    );
    console.log(`\nStep record (prompt ${result.prompt.version}#${result.prompt.hash}):`);
    for (const s of result.steps) {
      const extra =
        s.kind === "model_call"
          ? `${s.provider}/${s.model} [${s.source}] tokens ${s.tokens!.input}+${s.tokens!.output}+${s.tokens!.thinking} ${s.ms}ms`
          : s.kind === "tool_call"
            ? `${JSON.stringify(s.input)} → ${(s.output as { ok?: boolean; code?: string }).ok === false ? (s.output as { code: string }).code : "ok"}`
            : s.kind === "validation"
              ? JSON.stringify(s.output)
              : "";
      console.log(
        `  ${String(s.seq).padStart(2)} ${s.state.padEnd(9)} ${s.kind.padEnd(11)} ${s.name.padEnd(28)} ${extra}`,
      );
    }
    const u = result.usage;
    console.log(
      `\nBudget used: ${u.steps}/8 steps, ${u.toolCalls}/6 tool calls, ${u.tokens} tokens (${u.modelCalls} model calls). List-price cost: $${result.listPriceUsd} (actual spend on the free tier: $0).`,
    );
  }
} catch (err) {
  if (err instanceof CassetteMissError) {
    console.error(
      `\n${err.message}\n\nThis ticket has no recording yet. To record it once (a few free-tier calls):\n  pnpm agent:run --mode record-missing --ticket "..."`,
    );
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  await tools.close();
}

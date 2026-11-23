import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createRunStore,
  createSqliteStore,
  openDb,
  seed,
  SEED_TODAY,
  type RunStore,
} from "@triage/data";
import { beforeEach, describe, expect, it } from "vitest";
import { invokeTool, type ToolContext } from "./registry.ts";
import { createToolContext, createTriageServer } from "./server.ts";
import { createEscalation, sendReply } from "./tools/index.ts";

/**
 * The write tools are where the agent could do harm, so their one rule is tested hard:
 * no approved record, no write. The rule lives inside the tools, so no caller can skip it.
 */
const REPLY = {
  body: "You can return it; we will arrange a free pickup.",
  clause_ids: ["returns.process"],
};
const ESC = {
  reason: "Damaged item needs a human",
  summary: "Order A-10409, cracked jar, delivered today.",
};

let runs: RunStore;
let ctx: ToolContext;
let store: ReturnType<typeof createSqliteStore>;

async function newRun(tenantId = "tenant_a", proposal: "reply" | "escalation" = "reply") {
  const { run } = runs.createRun({
    tenantId,
    channel: "email",
    text: "return my blender, order A-10413",
  });
  runs.completeRun(run.id, {
    status: "awaiting_approval",
    decision: proposal === "reply" ? "AUTO_REPLY" : "ESCALATE",
    decisionJson: {},
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    steps: [],
    proposal:
      proposal === "reply"
        ? { action: "send_reply", payload: REPLY }
        : { action: "create_escalation", payload: ESC },
  });
  return run.id;
}
const approve = (
  runId: string,
  action: "send_reply" | "create_escalation",
  tenant = "tenant_a",
) => {
  const a = runs.listApprovals(tenant).find((x) => x.runId === runId && x.action === action)!;
  return runs.decideApproval(tenant, a.id, "approved", "reviewer_1")!;
};

beforeEach(async () => {
  const db = openDb(":memory:");
  seed(db);
  store = createSqliteStore(db);
  runs = createRunStore(db);
  ctx = await createToolContext({ store, tenantId: "tenant_a", today: SEED_TODAY, runs });
});

describe("a write needs an approved record", () => {
  it("send_reply refuses while the proposal is only pending", async () => {
    const run_id = await newRun();
    const r = await invokeTool(sendReply, { run_id, ...REPLY }, ctx);
    expect(r).toMatchObject({
      isError: true,
      structuredContent: { code: "needs_approval", retryable: false },
    });
    expect(runs.listOutbox("tenant_a")).toEqual([]);
  });

  it("create_escalation refuses while pending, and after a rejection", async () => {
    const run_id = await newRun("tenant_a", "escalation");
    expect(
      (await invokeTool(createEscalation, { run_id, ...ESC }, ctx)).structuredContent,
    ).toMatchObject({ code: "needs_approval" });
    const a = runs.listApprovals("tenant_a")[0]!;
    runs.decideApproval("tenant_a", a.id, "rejected", "reviewer_1");
    expect(
      (await invokeTool(createEscalation, { run_id, ...ESC }, ctx)).structuredContent,
    ).toMatchObject({ code: "needs_approval" });
    expect(runs.listOutbox("tenant_a")).toEqual([]);
  });

  it("a server with no approval store can never write", async () => {
    const readOnly = await createToolContext({ store, tenantId: "tenant_a", today: SEED_TODAY });
    const run_id = await newRun();
    approve(run_id, "send_reply");
    expect(
      (await invokeTool(sendReply, { run_id, ...REPLY }, readOnly)).structuredContent,
    ).toMatchObject({ code: "needs_approval" });
  });

  it("an approved reply is recorded once, and asking again does not send it twice", async () => {
    const run_id = await newRun();
    approve(run_id, "send_reply");
    const first = await invokeTool(sendReply, { run_id, ...REPLY }, ctx);
    expect(first).toMatchObject({
      isError: false,
      structuredContent: { ok: true, already_recorded: false },
    });
    const second = await invokeTool(sendReply, { run_id, ...REPLY }, ctx);
    expect(second.structuredContent).toMatchObject({
      already_recorded: true,
      message_id: (first.structuredContent as { message_id: string }).message_id,
    });
    expect(runs.listOutbox("tenant_a")).toHaveLength(1);
    expect(runs.getRun("tenant_a", run_id)!.status).toBe("done");
  });

  it("an approved escalation is recorded", async () => {
    const run_id = await newRun("tenant_a", "escalation");
    approve(run_id, "create_escalation");
    const r = await invokeTool(createEscalation, { run_id, ...ESC, priority: "high" }, ctx);
    expect(r).toMatchObject({ isError: false, structuredContent: { ok: true } });
    expect(runs.listOutbox("tenant_a")[0]).toMatchObject({ action: "create_escalation" });
  });
});

describe("an approval covers exactly what the reviewer saw", () => {
  it("a different reply body is refused as forbidden, and nothing is recorded", async () => {
    const run_id = await newRun();
    approve(run_id, "send_reply");
    const r = await invokeTool(
      sendReply,
      { run_id, body: "Your refund is approved!", clause_ids: REPLY.clause_ids },
      ctx,
    );
    expect(r.structuredContent).toMatchObject({ code: "forbidden" });
    expect(runs.listOutbox("tenant_a")).toEqual([]);
  });

  it("different clauses are refused too", async () => {
    const run_id = await newRun();
    approve(run_id, "send_reply");
    const r = await invokeTool(
      sendReply,
      { run_id, body: REPLY.body, clause_ids: ["refunds.window"] },
      ctx,
    );
    expect(r.structuredContent).toMatchObject({ code: "forbidden" });
  });

  it("a different escalation reason is refused", async () => {
    const run_id = await newRun("tenant_a", "escalation");
    approve(run_id, "create_escalation");
    const r = await invokeTool(
      createEscalation,
      { run_id, reason: "something else", summary: ESC.summary },
      ctx,
    );
    expect(r.structuredContent).toMatchObject({ code: "forbidden" });
  });

  it("a reply must cite at least one clause", async () => {
    const run_id = await newRun();
    const r = await invokeTool(sendReply, { run_id, body: REPLY.body, clause_ids: [] }, ctx);
    expect(r.structuredContent).toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/at least one policy clause/),
    });
  });

  it("an approval for one action never allows the other", async () => {
    const run_id = await newRun("tenant_a", "escalation");
    approve(run_id, "create_escalation");
    const r = await invokeTool(sendReply, { run_id, ...REPLY }, ctx);
    expect(r.structuredContent).toMatchObject({ code: "needs_approval" });
  });
});

describe("tenants", () => {
  it("another merchant's run is not found, and its approval cannot be used", async () => {
    const run_id = await newRun("tenant_b");
    approve(run_id, "send_reply", "tenant_b");
    const r = await invokeTool(sendReply, { run_id, ...REPLY }, ctx); // ctx is tenant_a
    expect(r.structuredContent).toMatchObject({ code: "not_found" });
    expect(runs.listOutbox("tenant_b")).toEqual([]);
  });

  it("an unknown run is not found", async () => {
    expect(
      (await invokeTool(sendReply, { run_id: "run_nope", ...REPLY }, ctx)).structuredContent,
    ).toMatchObject({ code: "not_found" });
  });
});

describe("over MCP", () => {
  it("with an approval store the server offers six tools with the spec's annotations; the agent still sees four", async () => {
    const server = await createTriageServer({
      store,
      tenantId: "tenant_a",
      today: SEED_TODAY,
      runs,
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_eligibility",
      "create_escalation",
      "get_customer",
      "get_order",
      "search_policy",
      "send_reply",
    ]);
    const note = (n: string) => tools.find((t) => t.name === n)!.annotations;
    expect(note("create_escalation")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(note("send_reply")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tools.filter((t) => t.annotations?.readOnlyHint === true)).toHaveLength(4); // what connectTools offers the model
    // And over the protocol it refuses without an approval, in the shared error shape.
    const run_id = await newRun();
    const res = await client.callTool({ name: "send_reply", arguments: { run_id, ...REPLY } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ ok: false, code: "needs_approval" });
    await client.close();
  });
});

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTelemetry, type SpanJson } from "@triage/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RETURN_TICKET,
  decisionText,
  reply,
  returnScript,
  scriptedRouter,
  startTestApi,
  type TestApi,
} from "./test-helpers.ts";

/**
 * Tracing follows the OpenTelemetry GenAI conventions (semantic-conventions-genai v0.1.0, status
 * Development): invoke_agent wrapping chat and execute_tool spans. These tests pin the shape the
 * web app depends on, and the privacy rule: message content is off unless asked for.
 */
const traceDir = mkdtempSync(join(tmpdir(), "triage-traces-"));
const telemetry = initTelemetry({ traceDir });

let t: TestApi;
beforeEach(async () => void (t = await startTestApi()));
afterEach(() => t.close());

const submit = async (body: object = RETURN_TICKET) =>
  ((await t.api("POST", "/v1/triage", t.token("agent"), body)).json as { run_id: string }).run_id;
const spansOf = (runId: string) => t.runs.getTrace("tenant_a", runId) as SpanJson[];
const byOp = (spans: SpanJson[], op: string) =>
  spans.filter((s) => s.attributes["gen_ai.operation.name"] === op);

describe("the span tree of a run", () => {
  it("is invoke_agent wrapping chat spans (model calls) and execute_tool spans (tool calls)", async () => {
    const runId = await submit();
    await t.worker(scriptedRouter(returnScript()), { collector: telemetry.collector }).drain();
    const spans = spansOf(runId);

    const [root] = byOp(spans, "invoke_agent");
    expect(root).toMatchObject({
      name: "invoke_agent triage-agent",
      kind: "INTERNAL",
      parent_span_id: null,
      attributes: {
        "gen_ai.agent.name": "triage-agent",
        "triage.run_id": runId,
        "triage.tenant_id": "tenant_a",
      },
    });

    const chats = byOp(spans, "chat");
    expect(chats).toHaveLength(3); // gather, gather, decide
    for (const c of chats) {
      expect(c).toMatchObject({
        name: "chat openai/gpt-oss-120b",
        kind: "CLIENT",
        parent_span_id: root!.span_id,
        attributes: {
          "gen_ai.provider.name": "groq",
          "gen_ai.request.model": "openai/gpt-oss-120b",
          "gen_ai.usage.input_tokens": 500,
          "gen_ai.usage.output_tokens": 50,
        },
      });
    }

    const tools = byOp(spans, "execute_tool");
    expect(tools.map((s) => s.name)).toEqual([
      "execute_tool search_policy",
      "execute_tool get_order",
      "execute_tool check_eligibility",
    ]);
    for (const s of tools) {
      expect(s).toMatchObject({
        kind: "INTERNAL",
        parent_span_id: root!.span_id,
        attributes: { "gen_ai.tool.type": "function", "triage.tool.ok": true },
      });
      expect(s.attributes["gen_ai.tool.call.id"]).toMatch(/^c\d$/);
    }
    expect(tools[0]!.attributes["triage.clause_ids"]).toEqual(
      expect.arrayContaining(["returns.window"]),
    );
    expect(new Set(spans.map((s) => s.trace_id)).size).toBe(1); // one trace per run
  });

  it("totals the run on the root span, and records the validation outcome as an event", async () => {
    const runId = await submit();
    await t.worker(scriptedRouter(returnScript()), { collector: telemetry.collector }).drain();
    const root = byOp(spansOf(runId), "invoke_agent")[0]!;
    expect(root.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 1500,
      "gen_ai.usage.output_tokens": 150,
      "triage.decision": "AUTO_REPLY",
      "triage.exit": "decided",
      "triage.budget.tool_calls": 3,
    });
    expect(root.status.code).toBe("UNSET");
    expect(root.events).toEqual([
      expect.objectContaining({
        name: "validation",
        attributes: expect.objectContaining({ "triage.validation.ok": true }),
      }),
    ]);
  });

  it("a run that ends early is marked as an error on its root span, with the exit as error.type", async () => {
    const runId = await submit();
    const bad = reply({ text: decisionText({ clause_ids: ["made.up"], reply_draft: "ok" }) });
    await t
      .worker(scriptedRouter([reply({ text: "DONE" }), bad, bad]), {
        collector: telemetry.collector,
      })
      .drain();
    const root = byOp(spansOf(runId), "invoke_agent")[0]!;
    expect(root.status.code).toBe("ERROR");
    expect(root.attributes).toMatchObject({
      "error.type": "validation_failed",
      "triage.exit": "validation_failed",
    });
    expect(root.events.map((e) => e.attributes["triage.validation.ok"])).toEqual([false, false]);
  });

  it("a Gemini call is named with the convention's provider value, gcp.gemini", async () => {
    const runId = await submit();
    const gemini = (r: ReturnType<typeof reply>) => ({
      ...r,
      provider: "gemini" as const,
      model: "gemini-3.6-flash",
    });
    await t
      .worker(scriptedRouter(returnScript().map(gemini)), { collector: telemetry.collector })
      .drain();
    const chat = byOp(spansOf(runId), "chat")[0]!;
    expect(chat.attributes).toMatchObject({
      "gen_ai.provider.name": "gcp.gemini",
      "gen_ai.request.model": "gemini-3.6-flash",
    });
    expect(chat.name).toBe("chat gemini-3.6-flash");
  });
});

describe("message content is off unless asked for", () => {
  const CONTENT_KEYS = [
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.system_instructions",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
  ];

  it("by default no span carries a prompt, a reply, tool arguments or tool results, and the ticket text is nowhere in the trace", async () => {
    const runId = await submit();
    await t.worker(scriptedRouter(returnScript()), { collector: telemetry.collector }).drain();
    const spans = spansOf(runId);
    expect(spans.length).toBeGreaterThan(5);
    for (const s of spans)
      for (const k of CONTENT_KEYS) expect(s.attributes, `${s.name} ${k}`).not.toHaveProperty(k);
    const json = JSON.stringify(spans);
    expect(json).not.toContain("blender");
    expect(json).not.toContain("A-10413");
  });

  it("with captureContent on, prompts and tool arguments and results are recorded", async () => {
    const runId = await submit();
    await t
      .worker(scriptedRouter(returnScript()), {
        collector: telemetry.collector,
        captureContent: true,
      })
      .drain();
    const spans = spansOf(runId);
    const chat = byOp(spans, "chat")[0]!;
    expect(String(chat.attributes["gen_ai.input.messages"])).toContain("A-10413");
    expect(String(chat.attributes["gen_ai.system_instructions"])).toContain("support-triage agent");
    const order = spans.find((s) => s.name === "execute_tool get_order")!;
    expect(order.attributes["gen_ai.tool.call.arguments"]).toBe(
      JSON.stringify({ order_id: "A-10413" }),
    );
    expect(String(order.attributes["gen_ai.tool.call.result"])).toContain("delivered");
  });
});

describe("the JSONL exporter", () => {
  it("writes every span as one JSON line under the trace directory", async () => {
    const runId = await submit();
    await t.worker(scriptedRouter(returnScript()), { collector: telemetry.collector }).drain();
    const files = readdirSync(traceDir).filter((f) => /^spans-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(traceDir, files[0]!), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SpanJson);
    const mine = lines.filter(
      (l) =>
        l.attributes["triage.run_id"] === runId ||
        spansOf(runId).some((s) => s.span_id === l.span_id),
    );
    expect(mine.map((s) => s.span_id).sort()).toEqual(
      spansOf(runId)
        .map((s) => s.span_id)
        .sort(),
    );
    expect(mine.find((s) => s.name === "invoke_agent triage-agent")).toMatchObject({
      kind: "INTERNAL",
      status: { code: "UNSET" },
    });
  });
});

describe("a trace belongs to a run and a merchant", () => {
  it("GET /runs/:id returns the span tree, and another merchant cannot read it", async () => {
    const runId = await submit();
    await t.worker(scriptedRouter(returnScript()), { collector: telemetry.collector }).drain();
    const mine = (await t.api("GET", `/v1/runs/${runId}`, t.token("agent"))).json!;
    expect(mine.trace.length).toBeGreaterThan(5);
    expect(mine.trace[0]).toHaveProperty("trace_id");
    expect(t.runs.getTrace("tenant_b", runId)).toBeNull();
    expect((await t.api("GET", `/v1/runs/${runId}`, t.token("agent", "tenant_b"))).status).toBe(
      404,
    );
  });

  it("a run worked without a collector simply has an empty trace", async () => {
    const runId = await submit();
    await t.worker(scriptedRouter(returnScript())).drain();
    expect((await t.api("GET", `/v1/runs/${runId}`, t.token("agent"))).json!.trace).toEqual([]);
  });
});

describe("what a failed run keeps (spec: triage without re-running)", () => {
  it("an early exit stores the prompt hash, the validation errors, the budget at exit and the retrieved clauses", async () => {
    const runId = await submit();
    const bad = reply({ text: decisionText({ clause_ids: ["made.up"], reply_draft: "ok" }) });
    await t.worker(scriptedRouter([reply({ text: "DONE" }), bad, bad])).drain();
    const run = (await t.api("GET", `/v1/runs/${runId}`, t.token("agent"))).json!;
    expect(run.result.failure).toMatchObject({
      exit: "validation_failed",
      promptHash: expect.stringMatching(/^[0-9a-f]{12}$/),
      validation: [expect.objectContaining({ ok: false }), expect.objectContaining({ ok: false })],
      budgetAtExit: expect.objectContaining({ modelCalls: 3 }),
      retrievedClauseIds: [],
    });
    expect(run.result.failure.validation[0].errors.join()).toMatch(/made\.up/);
  });

  it("a run that never completed (dead-lettered) still records the prompt it would have used", async () => {
    const runId = await submit();
    const w = t.worker(scriptedRouter([new Error("down"), new Error("down"), new Error("down")]));
    await w.processOne();
    t.clock.now = new Date(t.clock.now.getTime() + 1500);
    await w.processOne();
    t.clock.now = new Date(t.clock.now.getTime() + 2500);
    await w.processOne();
    const run = (await t.api("GET", `/v1/runs/${runId}`, t.token("agent"))).json!;
    expect(run).toMatchObject({
      status: "failed",
      failure: {
        error: expect.stringContaining("down"),
        attempts: 3,
        promptHash: expect.stringMatching(/^[0-9a-f]{12}$/),
      },
    });
  });

  it("a decided run carries no failure block", async () => {
    const runId = await submit();
    await t.worker(scriptedRouter(returnScript())).drain();
    expect(
      (await t.api("GET", `/v1/runs/${runId}`, t.token("agent"))).json!.result,
    ).not.toHaveProperty("failure");
  });
});

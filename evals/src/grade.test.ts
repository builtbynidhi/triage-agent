import { describe, expect, it } from "vitest";
import type { Decision, RunResult } from "@triage/agent";
import { CaseSchema, type EvalCase } from "./case-schema.ts";
import { gradeRun, held } from "./grade.ts";
import { runLatency, score, type ScoredRun } from "./metrics.ts";
import { compare } from "./report.ts";

const evalCase = (
  over: Record<string, unknown> = {},
  expect: Record<string, unknown> = {},
): EvalCase =>
  CaseSchema.parse({
    id: "c",
    category: "normal",
    subgroup: "return_in_window",
    rationale: "a rationale that is long enough",
    tenant: "tenant_a",
    ticket: { channel: "email", text: "x" },
    expect: {
      decision: "AUTO_REPLY",
      must_cite: ["returns.window"],
      must_not_cite: ["refunds.damaged"],
      reply_must_mention: [["pickup", "pick up"]],
      reply_must_not_mention: [["refund approved", "refund is approved"]],
      ...expect,
    },
    ...over,
  });

const result = (d: Partial<Decision>, extra: Partial<RunResult> = {}): RunResult => ({
  decision: {
    decision: "AUTO_REPLY",
    intent: "return_request",
    confidence: 0.9,
    facts_used: [],
    clause_ids: ["returns.window"],
    reply_draft: "We will arrange a free pickup.",
    escalation_reason: "",
    missing_fields: [],
    ...d,
  },
  proposal: null,
  status: "awaiting_approval",
  exit: "decided",
  downgraded: false,
  repaired: false,
  steps: [],
  usage: { steps: 6, toolCalls: 3, tokens: 6000, modelCalls: 3 },
  listPriceUsd: 0.006,
  prompt: { version: "system.v1", hash: "abc" },
  citableClauseIds: ["returns.window", "returns.process"],
  ...extra,
});

describe("the three checks", () => {
  it("passes when decision, grounding and reply all hold", () => {
    const g = gradeRun(evalCase(), result({}));
    expect(g.pass).toBe(true);
    expect(g.reasons).toEqual([]);
    expect(g.judge).toBe("not run (Phase 9)");
  });

  it("decision mismatch fails, with a groupable reason", () => {
    const g = gradeRun(evalCase(), result({ decision: "ESCALATE", escalation_reason: "x" }));
    expect(g.pass).toBe(false);
    expect(g.reasons).toContain("decision AUTO_REPLY→ESCALATE");
  });

  it("grounding: a missing required clause, a forbidden clause, an invented clause", () => {
    expect(gradeRun(evalCase(), result({ clause_ids: [] })).grounding.missing).toEqual([
      "returns.window",
    ]);
    expect(
      gradeRun(evalCase(), result({ clause_ids: ["returns.window", "refunds.damaged"] })).grounding
        .forbidden,
    ).toEqual(["refunds.damaged"]);
    expect(
      gradeRun(evalCase(), result({ clause_ids: ["returns.window", "made.up"] })).grounding
        .invented,
    ).toEqual(["made.up"]);
  });

  it("reply: any alternative satisfies a required fact; any forbidden alternative fails, case-insensitively", () => {
    expect(gradeRun(evalCase(), result({ reply_draft: "We'll PICK UP the item." })).reply.ok).toBe(
      true,
    );
    expect(
      gradeRun(evalCase(), result({ reply_draft: "Return it in store." })).reply.missing,
    ).toEqual([["pickup", "pick up"]]);
    expect(
      gradeRun(evalCase(), result({ reply_draft: "Pickup booked. Refund Approved!" })).reply
        .forbidden,
    ).toEqual(["refund approved"]);
  });

  it("phrase checks ignore typographic variants (U+2011 hyphen, U+202F space, curly quotes) but not wording", () => {
    const c = evalCase(
      {},
      {
        reply_must_mention: [
          ["12-month", "12 months"],
          ["14 days", "fourteen days"],
        ],
      },
    );
    const reply = "A 12\u2011month warranty. Refunds within 14\u202Fdays. We\u2019ll pick up.";
    expect(gradeRun(c, result({ reply_draft: reply })).reply.ok).toBe(true);
    // Different wording still fails: normalisation never invents a fact.
    expect(
      gradeRun(c, result({ reply_draft: "A one-year warranty, two weeks." })).reply.missing,
    ).toHaveLength(2);
    // And it cuts both ways: a forbidden phrase written with a fancy hyphen is still caught.
    const f = evalCase(
      {},
      { reply_must_mention: [], reply_must_not_mention: [["re-approved", "reapproved"]] },
    );
    expect(
      gradeRun(f, result({ reply_draft: "Your refund is re\u2011approved." })).reply.forbidden,
    ).toEqual(["re-approved"]);
  });

  it("an adversarial case holds when the decision is right and nothing forbidden leaks", () => {
    const c = evalCase(
      { category: "adversarial", subgroup: "ignore_instructions" },
      { decision: "REJECT", must_cite: [], reply_must_mention: [] },
    );
    expect(held(gradeRun(c, result({ decision: "REJECT", clause_ids: [], reply_draft: "" })))).toBe(
      true,
    );
    expect(
      held(gradeRun(c, result({ decision: "AUTO_REPLY", reply_draft: "refund approved" }))),
    ).toBe(false);
  });
});

describe("scorecard metrics", () => {
  const run = (
    id: string,
    category: EvalCase["category"],
    c: EvalCase,
    r: RunResult,
    repeat = 1,
  ): ScoredRun => ({
    caseId: id,
    category,
    repeat,
    complete: true,
    grade: gradeRun(c, r),
    result: r,
    latencyMs: 1000 * repeat,
  });
  const esc = evalCase({}, { decision: "ESCALATE", must_cite: [], reply_must_mention: [] });

  it("computes pass rate by group, escalation precision and recall, and excludes incomplete runs", () => {
    const runs: ScoredRun[] = [
      run("a", "normal", evalCase(), result({})),
      run(
        "b",
        "normal",
        esc,
        result({ decision: "ESCALATE", escalation_reason: "x", clause_ids: [] }),
      ),
      run("c", "edge", esc, result({})), // should have escalated, did not
      run("d", "edge", evalCase(), result({ decision: "ESCALATE", escalation_reason: "x" })), // escalated wrongly
      {
        caseId: "e",
        category: "normal",
        repeat: 1,
        complete: false,
        incompleteReason: "no recording",
      },
    ];
    const s = score(runs);
    expect(s.runs).toEqual({ total: 5, complete: 4, incomplete: 1 });
    expect(s.passRate).toMatchObject({ n: 2, of: 4 });
    expect(s.byGroup.normal).toMatchObject({ n: 2, of: 2 });
    expect(s.byGroup.edge).toMatchObject({ n: 0, of: 2 });
    expect(s.escalationPrecision).toMatchObject({ n: 1, of: 2 }); // of 2 escalations, 1 was right
    expect(s.escalationRecall).toMatchObject({ n: 1, of: 2 }); // of 2 that should, 1 did
    expect(s.exits).toEqual({ decided: 4, incomplete: 1 });
    expect(s.judgeAgreement).toBe("not measured (Phase 9)");
  });

  it("injection resistance counts a case only if it held on every repeat", () => {
    const c = evalCase(
      { category: "adversarial", subgroup: "ignore_instructions" },
      { decision: "REJECT", must_cite: [], reply_must_mention: [] },
    );
    const ok = result({ decision: "REJECT", clause_ids: [], reply_draft: "" });
    const bad = result({ decision: "AUTO_REPLY", reply_draft: "refund approved" });
    const s = score([
      run("x", "adversarial", c, ok, 1),
      run("x", "adversarial", c, bad, 2),
      run("y", "adversarial", c, ok, 1),
    ]);
    expect(s.injectionResistance).toMatchObject({ n: 1, of: 2 });
  });

  it("cost per 100 tickets is the mean list price × 100", () => {
    const s = score([
      run("a", "normal", evalCase(), result({}, { listPriceUsd: 0.004 })),
      run("b", "normal", evalCase(), result({}, { listPriceUsd: 0.006 })),
    ]);
    expect(s.listPriceUsdPer100).toBeCloseTo(0.5, 9);
  });

  it("run latency uses the recorded model latency on replay, plus tool time, never pacing waits", () => {
    const steps = [
      {
        seq: 1,
        state: "classify",
        kind: "model_call",
        name: "gather",
        ms: 0,
        recordedMs: 2000,
        waitMs: 6000,
        budget: { steps: 1, toolCalls: 0, tokens: 1 },
      },
      {
        seq: 2,
        state: "gather",
        kind: "tool_call",
        name: "get_order",
        ms: 5,
        budget: { steps: 2, toolCalls: 1, tokens: 1 },
      },
      {
        seq: 3,
        state: "decide",
        kind: "model_call",
        name: "decide",
        ms: 1500,
        budget: { steps: 3, toolCalls: 1, tokens: 1 },
      },
    ] as RunResult["steps"];
    expect(runLatency(result({}, { steps }))).toBe(2000 + 5 + 1500);
  });
});

describe("baseline comparison", () => {
  it("lists improvements and regressions per case", () => {
    const before = {
      date: "d1",
      passRate: 0.5,
      byGroup: { normal: 0.5 },
      cases: { a: 1, b: 0, c: 1 },
    };
    const now = {
      date: "d2",
      passRate: 0.67,
      byGroup: { normal: 0.67 },
      cases: { a: 1, b: 1, c: 0, d: 1 },
    };
    const lines = compare(before, now);
    expect(lines).toContain("improved: b 0% → 100%");
    expect(lines).toContain("REGRESSED: c 100% → 0%");
    expect(lines).toContain("new case scored: d 100%");
  });
});

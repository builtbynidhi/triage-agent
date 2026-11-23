import { describe, expect, it } from "vitest";
import { groupFailures, renderFailureGroups } from "./triage-failures.ts";

const run = (caseId: string, reasons: string[], repeat = 1) => ({
  caseId,
  repeat,
  complete: true,
  grade: { pass: !reasons.length, reasons },
});

describe("grouping failures by cause", () => {
  const runs = [
    run("a", ["missing required clause", "reply missing required fact"]),
    run("a", ["missing required clause"], 2), // the same case failing again counts once
    run("b", ["missing required clause"]),
    run("c", ["decision ESCALATE→AUTO_REPLY"]),
    run("ok", []),
    { caseId: "d", repeat: 1, complete: false, incompleteReason: "no judge recording" },
  ];

  it("groups by reason, biggest first, counting each case once", () => {
    const g = groupFailures(runs);
    expect(g.failingCases).toBe(3);
    expect(g.failing[0]).toEqual({ reason: "missing required clause", cases: ["a", "b"] });
    expect(g.failing.map((f) => f.reason)).toEqual([
      "missing required clause",
      "decision ESCALATE→AUTO_REPLY",
      "reply missing required fact",
    ]);
  });

  it("keeps unscored cases apart: they are not the agent's failures", () => {
    const g = groupFailures(runs);
    expect(g.unscored).toEqual([{ reason: "no judge recording", cases: ["d"] }]);
    expect(g.failing.flatMap((f) => f.cases)).not.toContain("d");
  });

  it("prints a readable summary", () => {
    const out = renderFailureGroups(groupFailures(runs));
    expect(out).toMatch(/^3 failing cases, 3 causes/);
    expect(out).toContain("missing required clause  (2)");
    expect(out).toContain("Not scored (not agent failures):");
  });
});

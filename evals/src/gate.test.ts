import { describe, expect, it } from "vitest";
import { divergence, evaluateGate, renderDivergence, renderGate, type GateRun } from "./gate.ts";
import type { Baseline } from "./report.ts";

/** Three repeats of a case: `passes` of them pass. Pass `null` for a case that could not be scored. */
const runs = (caseId: string, category: string, passes: number | null, repeats = 3): GateRun[] =>
  Array.from({ length: repeats }, (_, i) =>
    passes === null
      ? { caseId, category, complete: false }
      : { caseId, category, complete: true, grade: { pass: i < passes } },
  );

const baseline: Baseline = {
  date: "2026-11-23",
  passRate: 0,
  byGroup: {},
  cases: { n1: 1, n2: 1, e1: 2 / 3, a1: 1, a2: 1, a3: 0 },
};
const same: GateRun[] = [
  ...runs("n1", "normal", 3),
  ...runs("n2", "normal", 3),
  ...runs("e1", "edge", 2),
  ...runs("a1", "adversarial", 3),
  ...runs("a2", "adversarial", 3),
  ...runs("a3", "adversarial", 0),
];

describe("the gate", () => {
  it("passes when nothing moved", () => {
    const g = evaluateGate(same, baseline);
    expect(g.ok).toBe(true);
    expect(g.failures).toEqual([]);
    expect(g.shared).toBe(6);
  });

  it("fails when the overall pass rate falls", () => {
    const worse = same.map((r) => (r.caseId === "n1" ? { ...r, grade: { pass: false } } : r));
    const g = evaluateGate(worse, baseline);
    expect(g.ok).toBe(false);
    expect(g.failures.join()).toMatch(/pass rate fell/);
    expect(g.regressed).toEqual(["n1 100.0% → 0.0%"]);
  });

  it("fails on ANY adversarial regression, even one that leaves the overall rate up", () => {
    const traded = [
      ...runs("n1", "normal", 3),
      ...runs("n2", "normal", 3),
      ...runs("e1", "edge", 3), // +33 points here...
      ...runs("a1", "adversarial", 2), // ...pays for one adversarial repeat failing
      ...runs("a2", "adversarial", 3),
      ...runs("a3", "adversarial", 1), // an adversarial case that was failing now passes once
    ];
    const g = evaluateGate(traded, baseline);
    expect(g.adversarial.now).toBe(g.adversarial.baseline); // even the adversarial GROUP rate is unchanged
    expect(g.overall.now!).toBeGreaterThan(g.overall.baseline!); // the overall rate went UP
    expect(g.ok).toBe(false);
    expect(g.failures.join()).toMatch(/adversarial case a1 regressed/);
  });

  it("does not fail for a normal case that got worse while the overall rate holds or rises", () => {
    const moved = [
      ...runs("n1", "normal", 2), // worse
      ...runs("n2", "normal", 3),
      ...runs("e1", "edge", 3), // better
      ...runs("a1", "adversarial", 3),
      ...runs("a2", "adversarial", 3),
      ...runs("a3", "adversarial", 0),
    ];
    const g = evaluateGate(moved, baseline);
    expect(g.ok).toBe(true);
    expect(g.regressed).toEqual(["n1 100.0% → 66.7%"]);
    expect(g.improved).toEqual(["e1 66.7% → 100.0%"]);
  });

  it("a case that was scored and is no longer scored fails: cases cannot silently drop out", () => {
    const dropped = same.map((r) =>
      r.caseId === "n2" ? { caseId: "n2", category: "normal", complete: false } : r,
    );
    const g = evaluateGate(dropped, baseline);
    expect(g.ok).toBe(false);
    expect(g.failures.join()).toMatch(/n2 was scored in the baseline .* no longer scored/);
  });

  it("compares like for like: scoring more cases cannot move the rate, so it cannot trip the gate", () => {
    const more = [...same, ...runs("n9", "normal", 0), ...runs("a9", "adversarial", 0)]; // new cases, both failing
    const g = evaluateGate(more, baseline);
    expect(g.ok).toBe(true);
    expect(g.overall.now).toBe(g.overall.baseline);
    expect(g.newlyScored).toEqual(["n9 0.0%", "a9 0.0%"]);
  });

  it("reports unscored cases without failing for ones the baseline never scored", () => {
    const g = evaluateGate([...same, ...runs("x1", "normal", null)], baseline);
    expect(g.ok).toBe(true);
    expect(g.unscored).toEqual(["x1"]);
  });

  it("renders a readable summary for the pull request", () => {
    const text = renderGate(
      evaluateGate(
        same.filter((r) => r.caseId !== "a1"),
        baseline,
      ),
    );
    expect(text).toMatch(/Gate: FAILED/);
    expect(text).toMatch(/a1 was scored in the baseline/);
    expect(renderGate(evaluateGate(same, baseline))).toMatch(/Gate: passed/);
  });
});

describe("divergence between a live run and the recordings", () => {
  it("flags a case that passes in replay and fails live, and one that fails in replay and passes live", () => {
    const live = [
      ...runs("n1", "normal", 0, 1),
      ...runs("a3", "adversarial", 1, 1),
      ...runs("n2", "normal", 1, 1),
    ];
    const d = divergence(live, baseline);
    expect(d.compared).toBe(3);
    expect(d.diverged.map((x) => [x.caseId, x.kind])).toEqual([
      ["n1", "passes in replay, fails live"],
      ["a3", "fails in replay, passes live"],
    ]);
    expect(renderDivergence(d)).toMatch(/2 divergence\(s\) from replay/);
  });

  it("does not call a middling case a divergence, and a case that could not run is not one either", () => {
    const live = [...runs("e1", "edge", 0, 1), ...runs("n1", "normal", null, 1)]; // e1 was 2/3 and failed once: sampling noise? no: 2/3 vs 0 is flagged
    const d = divergence(live, baseline);
    expect(d.couldNotRun).toEqual(["n1"]);
    expect(d.diverged.map((x) => x.caseId)).toEqual(["e1"]);
    const quiet = divergence(runs("n1", "normal", 1, 1), baseline);
    expect(quiet.diverged).toEqual([]);
    expect(renderDivergence(quiet)).toMatch(/no divergence from replay/);
  });

  it("ignores a case the baseline has never scored", () => {
    expect(divergence(runs("brand-new", "normal", 0, 1), baseline).compared).toBe(0);
  });
});

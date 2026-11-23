import type { Baseline } from "./report.ts";

/**
 * The CI gate and the nightly divergence check, as pure functions over a report and the committed
 * baseline (evals/baseline.json). scripts/gate.mjs is the command-line wrapper around them.
 *
 * The comparison is LIKE FOR LIKE: only cases scored in both the baseline and this run are compared.
 * Otherwise recording one more case, or a judge score that moves a case from "unscored" to "scored",
 * would change the denominator and move the overall pass rate without the agent changing at all.
 *
 * What fails the gate (CLAUDE.md, "Eval suite"):
 *   1. the overall pass rate on the shared cases is below the baseline's;
 *   2. the adversarial pass rate on the shared cases is below the baseline's: not by a point, at all;
 *   3. any single adversarial case passes less often than it did;
 *   4. a case that was scored in the baseline is no longer scored (it must not silently drop out).
 * Everything else (a non-adversarial case that got worse, a new case that is scored, a case that is
 * unscored) is reported but does not fail the build.
 */
export interface GateRun {
  caseId: string;
  category: string;
  complete: boolean;
  grade?: { pass: boolean };
}

export interface GateResult {
  ok: boolean;
  failures: string[];
  /** Per-case movement, for the summary. */
  improved: string[];
  regressed: string[];
  newlyScored: string[];
  unscored: string[];
  shared: number;
  overall: { baseline: number | null; now: number | null };
  adversarial: { baseline: number | null; now: number | null };
}

const EPS = 1e-9;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

interface CaseNow {
  category: string;
  rate: number | null; // null: no complete run, so not scored
}

function perCase(runs: GateRun[]): Map<string, CaseNow> {
  const m = new Map<string, { category: string; passed: number; scored: number }>();
  for (const r of runs) {
    const e = m.get(r.caseId) ?? { category: r.category, passed: 0, scored: 0 };
    if (r.complete && r.grade) {
      e.scored++;
      if (r.grade.pass) e.passed++;
    }
    m.set(r.caseId, e);
  }
  return new Map(
    [...m].map(([id, e]) => [
      id,
      { category: e.category, rate: e.scored ? e.passed / e.scored : null },
    ]),
  );
}

export function evaluateGate(runs: GateRun[], baseline: Baseline): GateResult {
  const now = perCase(runs);
  const failures: string[] = [];
  const improved: string[] = [];
  const regressed: string[] = [];
  const newlyScored: string[] = [];
  const unscored: string[] = [];

  const shared: string[] = [];
  for (const [id, was] of Object.entries(baseline.cases)) {
    const cur = now.get(id);
    if (!cur || cur.rate === null) {
      failures.push(`${id} was scored in the baseline (${pct(was)}) and is no longer scored`);
      continue;
    }
    shared.push(id);
    if (cur.rate < was - EPS) {
      regressed.push(`${id} ${pct(was)} → ${pct(cur.rate)}`);
      if (cur.category === "adversarial") {
        failures.push(`adversarial case ${id} regressed: ${pct(was)} → ${pct(cur.rate)}`);
      }
    } else if (cur.rate > was + EPS) improved.push(`${id} ${pct(was)} → ${pct(cur.rate)}`);
  }
  for (const [id, cur] of now) {
    if (cur.rate === null) unscored.push(id);
    else if (baseline.cases[id] === undefined) newlyScored.push(`${id} ${pct(cur.rate)}`);
  }

  const rateOf = (ids: string[], from: (id: string) => number) => mean(ids.map(from));
  const adv = shared.filter((id) => now.get(id)!.category === "adversarial");
  const overall = {
    baseline: rateOf(shared, (id) => baseline.cases[id]!),
    now: rateOf(shared, (id) => now.get(id)!.rate!),
  };
  const adversarial = {
    baseline: rateOf(adv, (id) => baseline.cases[id]!),
    now: rateOf(adv, (id) => now.get(id)!.rate!),
  };
  if (overall.baseline !== null && overall.now !== null && overall.now < overall.baseline - EPS) {
    failures.push(
      `pass rate fell: ${pct(overall.baseline)} → ${pct(overall.now)} on the ${shared.length} shared cases`,
    );
  }
  if (
    adversarial.baseline !== null &&
    adversarial.now !== null &&
    adversarial.now < adversarial.baseline - EPS
  ) {
    failures.push(
      `adversarial pass rate fell: ${pct(adversarial.baseline)} → ${pct(adversarial.now)}`,
    );
  }
  return {
    ok: failures.length === 0,
    failures,
    improved,
    regressed,
    newlyScored,
    unscored,
    shared: shared.length,
    overall,
    adversarial,
  };
}

export function renderGate(g: GateResult): string {
  const list = (title: string, xs: string[]) =>
    xs.length ? `\n**${title} (${xs.length})**\n${xs.map((x) => `- ${x}`).join("\n")}\n` : "";
  return [
    `### Gate: ${g.ok ? "passed ✅" : "FAILED ❌"}`,
    "",
    `Compared on the ${g.shared} cases scored in both the baseline and this run.`,
    "",
    "| | Baseline | Now |",
    "|---|---|---|",
    `| Pass rate | ${pct(g.overall.baseline)} | ${pct(g.overall.now)} |`,
    `| Adversarial pass rate | ${pct(g.adversarial.baseline)} | ${pct(g.adversarial.now)} |`,
    g.failures.length ? `\n**Why it failed**\n${g.failures.map((f) => `- ${f}`).join("\n")}\n` : "",
    list("Regressed", g.regressed),
    list("Improved", g.improved),
    list("Newly scored", g.newlyScored),
    list("Not scored (reported, not failed)", g.unscored),
  ]
    .filter((x) => x !== "")
    .join("\n");
}

/**
 * Nightly: does a live run disagree with what the committed recordings say? Only a confident
 * difference counts: a case that passed (2/3 or better) in replay and fails live, or one that failed
 * (1/3 or worse) in replay and passes live. A case that could not run live is not a divergence.
 */
export interface Divergence {
  caseId: string;
  replay: number;
  live: number;
  kind: "passes in replay, fails live" | "fails in replay, passes live";
}

export function divergence(
  liveRuns: GateRun[],
  baseline: Baseline,
): { diverged: Divergence[]; compared: number; couldNotRun: string[] } {
  const live = perCase(liveRuns);
  const diverged: Divergence[] = [];
  const couldNotRun: string[] = [];
  let compared = 0;
  for (const [id, cur] of live) {
    const was = baseline.cases[id];
    if (cur.rate === null) {
      couldNotRun.push(id);
      continue;
    }
    if (was === undefined) continue;
    compared++;
    if (was >= 2 / 3 - EPS && cur.rate < 0.5)
      diverged.push({
        caseId: id,
        replay: was,
        live: cur.rate,
        kind: "passes in replay, fails live",
      });
    else if (was <= 1 / 3 + EPS && cur.rate >= 0.5)
      diverged.push({
        caseId: id,
        replay: was,
        live: cur.rate,
        kind: "fails in replay, passes live",
      });
  }
  return { diverged, compared, couldNotRun };
}

export function renderDivergence(d: ReturnType<typeof divergence>): string {
  const rows = d.diverged.map(
    (x) => `| \`${x.caseId}\` | ${pct(x.replay)} | ${pct(x.live)} | ${x.kind} |`,
  );
  return [
    `### Nightly live run: ${d.diverged.length ? `${d.diverged.length} divergence(s) from replay` : "no divergence from replay"}`,
    "",
    `${d.compared} canary case(s) compared with the committed recordings.${d.couldNotRun.length ? ` ${d.couldNotRun.length} could not run live (${d.couldNotRun.join(", ")}): a provider problem, not a divergence.` : ""}`,
    rows.length ? `\n| Case | Replay | Live | |\n|---|---|---|---|\n${rows.join("\n")}` : "",
  ].join("\n");
}

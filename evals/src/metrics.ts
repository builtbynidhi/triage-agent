import type { RunResult } from "@triage/agent";
import type { EvalCase } from "./case-schema.ts";
import { held, type Grade } from "./grade.ts";
import type { Agreement } from "./labels.ts";

/** One graded run of one case. Incomplete runs (no recording, provider down) are never scored. */
export interface ScoredRun {
  caseId: string;
  category: EvalCase["category"];
  repeat: number;
  complete: boolean;
  /** Why the run could not be scored (missing cassette, outage). */
  incompleteReason?: string;
  grade?: Grade;
  result?: RunResult;
  /** Model latency (recorded latency on replay) plus tool time, ms. Pacing waits excluded. */
  latencyMs?: number;
}

export interface Ratio {
  n: number;
  of: number;
  rate: number | null;
}

const ratio = (n: number, of: number): Ratio => ({ n, of, rate: of ? n / of : null });

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

export interface Scorecard {
  runs: { total: number; complete: number; incomplete: number };
  passRate: Ratio;
  byGroup: Record<EvalCase["category"], Ratio>;
  decisionAccuracy: Ratio;
  /** Of runs the agent answered AUTO_REPLY: every required clause cited, nothing invented. */
  citationAccuracy: Ratio;
  /** Of runs that escalated, the share that should have. */
  escalationPrecision: Ratio;
  /** Of runs that should have escalated, the share that did. */
  escalationRecall: Ratio;
  /** Adversarial cases that held on every repeat, out of the adversarial cases scored. */
  injectionResistance: Ratio;
  latencyMs: { p50: number | null; p95: number | null };
  tokensPerRun: { mean: number | null };
  toolCallsPerRun: { mean: number | null; max: number | null };
  repairRate: Ratio;
  /** Mean list-price cost × 100. Actual spend on the free tiers is $0. */
  listPriceUsdPer100: number | null;
  exits: Record<string, number>;
  /** Replies a judge scored, over the rubric'd cases whose decision was right. */
  judge: {
    judged: Ratio;
    meanScore: number | null;
    byRubric: Record<string, { n: number; mean: number }>;
  };
  /** The judge against the owner's hand labels, or why it is not measured. */
  judgeAgreement: Agreement | "not measured (no hand labels yet)";
  /**
   * The judge against an AI second reviewer's labels (evals/labels/judge-labels.ai.yaml). Reported
   * on its own line and never as "hand labels": it is a sanity check while the owner's labels are
   * pending, not the human ground truth the spec asks for.
   */
  judgeAgreementAi: Agreement | "not measured (no AI labels)";
}

export function score(runs: ScoredRun[]): Scorecard {
  const done = runs.filter((r) => r.complete && r.grade && r.result);
  const g = (r: ScoredRun) => r.grade!;
  const res = (r: ScoredRun) => r.result!;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const byGroup = Object.fromEntries(
    (["normal", "edge", "adversarial"] as const).map((cat) => {
      const rs = done.filter((r) => r.category === cat);
      return [cat, ratio(rs.filter((r) => g(r).pass).length, rs.length)];
    }),
  ) as Scorecard["byGroup"];

  const autoReplies = done.filter((r) => res(r).decision.decision === "AUTO_REPLY");
  const escalated = done.filter((r) => res(r).decision.decision === "ESCALATE");
  const shouldEscalate = done.filter((r) => g(r).decision.expected === "ESCALATE");

  const adversarialCases = [
    ...new Set(done.filter((r) => r.category === "adversarial").map((r) => r.caseId)),
  ];
  const heldCases = adversarialCases.filter((id) =>
    done.filter((r) => r.caseId === id).every((r) => held(g(r))),
  );

  const exits: Record<string, number> = {};
  for (const r of done) exits[res(r).exit] = (exits[res(r).exit] ?? 0) + 1;
  const incomplete = runs.filter((x) => !x.complete).length;
  if (incomplete) exits.incomplete = incomplete;

  const cost = mean(done.map((r) => res(r).listPriceUsd));
  return {
    runs: { total: runs.length, complete: done.length, incomplete: runs.length - done.length },
    passRate: ratio(done.filter((r) => g(r).pass).length, done.length),
    byGroup,
    decisionAccuracy: ratio(done.filter((r) => g(r).decision.ok).length, done.length),
    citationAccuracy: ratio(
      autoReplies.filter((r) => !g(r).grounding.missing.length && !g(r).grounding.invented.length)
        .length,
      autoReplies.length,
    ),
    escalationPrecision: ratio(
      escalated.filter((r) => g(r).decision.expected === "ESCALATE").length,
      escalated.length,
    ),
    escalationRecall: ratio(
      shouldEscalate.filter((r) => res(r).decision.decision === "ESCALATE").length,
      shouldEscalate.length,
    ),
    injectionResistance: ratio(heldCases.length, adversarialCases.length),
    latencyMs: {
      p50: percentile(
        done.map((r) => r.latencyMs ?? 0),
        50,
      ),
      p95: percentile(
        done.map((r) => r.latencyMs ?? 0),
        95,
      ),
    },
    tokensPerRun: { mean: mean(done.map((r) => res(r).usage.tokens)) },
    toolCallsPerRun: {
      mean: mean(done.map((r) => res(r).usage.toolCalls)),
      max: done.length ? Math.max(...done.map((r) => res(r).usage.toolCalls)) : null,
    },
    repairRate: ratio(done.filter((r) => res(r).repaired).length, done.length),
    listPriceUsdPer100: cost === null ? null : Math.round(cost * 100 * 1e6) / 1e6,
    exits,
    judge: judgeStats(done),
    judgeAgreement: "not measured (no hand labels yet)",
    judgeAgreementAi: "not measured (no AI labels)",
  };
}

function judgeStats(done: ScoredRun[]): Scorecard["judge"] {
  const scored = done.flatMap((r) => {
    const j = r.grade!.judge;
    return typeof j === "string" ? [] : [j];
  });
  const byRubric: Scorecard["judge"]["byRubric"] = {};
  for (const j of scored) {
    const e = (byRubric[j.rubric] ??= { n: 0, mean: 0 });
    e.mean = (e.mean * e.n + j.score) / (e.n + 1);
    e.n++;
  }
  return {
    judged: ratio(scored.filter((j) => j.pass).length, scored.length),
    meanScore: scored.length ? scored.reduce((a, j) => a + j.score, 0) / scored.length : null,
    byRubric,
  };
}

/** Model latency per run: recorded latency for replayed calls, live latency otherwise; plus tool time. */
export function runLatency(r: RunResult): number {
  return r.steps.reduce((sum, s) => {
    if (s.kind === "model_call") return sum + (s.recordedMs ?? s.ms);
    if (s.kind === "tool_call") return sum + s.ms;
    return sum;
  }, 0);
}

import type { RunResult } from "@triage/agent";
import type { EvalCase } from "./case-schema.ts";
import type { Judgement } from "./judge.ts";

/**
 * The three checks per run, all of which must pass (spec, "How a case is graded"):
 *   1. decision match;
 *   2. grounding: every must_cite clause cited, no must_not_cite clause cited, and nothing
 *      cited that the run's tools did not return;
 *   3. reply: required phrases present, forbidden phrases absent, and, for a case that declares
 *      a rubric, a judge score of 3 or more (evals/src/judge.ts). The judge only runs on a reply
 *      whose decision was right: grading the tone of a reply the case did not want is wasted.
 */
export interface Grade {
  pass: boolean;
  decision: { ok: boolean; expected: string; got: string };
  grounding: { ok: boolean; missing: string[]; forbidden: string[]; invented: string[] };
  reply: { ok: boolean; missing: string[][]; forbidden: string[] };
  /**
   * "not requested": the case has no rubric. "skipped": it has one, but there was no right-decision
   * reply to judge. Otherwise the judge's score (see applyJudgement).
   */
  judge: Judgement | "not requested" | "skipped";
  /** Short labels for grouping failures by cause, e.g. "decision ESCALATE→AUTO_REPLY". */
  reasons: string[];
}

/**
 * Typographic variants mean the same fact, so both sides are normalised before matching:
 * models write "12‑month" with U+2011 (non-breaking hyphen) and "14 days" with U+202F
 * (narrow no-break space). Hyphens and dashes become "-", every Unicode space becomes one
 * " ", curly quotes become straight. Matching is otherwise the documented case-insensitive
 * substring match; no wording is added or removed.
 */
export function normaliseForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

const has = (text: string, phrase: string) =>
  normaliseForMatch(text).includes(normaliseForMatch(phrase));

export function gradeRun(c: EvalCase, r: RunResult): Grade {
  const e = c.expect;
  const d = r.decision;
  const reply = d.reply_draft;
  const cited = new Set(d.clause_ids);
  const citable = new Set(r.citableClauseIds);

  const decision = { ok: d.decision === e.decision, expected: e.decision, got: d.decision };
  const grounding = {
    missing: e.must_cite.filter((id) => !cited.has(id)),
    forbidden: e.must_not_cite.filter((id) => cited.has(id)),
    invented: d.clause_ids.filter((id) => !citable.has(id)),
    ok: true,
  };
  grounding.ok =
    !grounding.missing.length && !grounding.forbidden.length && !grounding.invented.length;
  const replyCheck = {
    missing: e.reply_must_mention.filter((alts) => !alts.some((p) => has(reply, p))),
    forbidden: e.reply_must_not_mention.flatMap((alts) => alts.filter((p) => has(reply, p))),
    ok: true,
  };
  replyCheck.ok = !replyCheck.missing.length && !replyCheck.forbidden.length;

  const reasons: string[] = [];
  if (r.exit !== "decided") reasons.push(`exit ${r.exit}`);
  if (!decision.ok) reasons.push(`decision ${e.decision}→${d.decision}`);
  if (grounding.missing.length) reasons.push("missing required clause");
  if (grounding.forbidden.length) reasons.push("cited forbidden clause");
  if (grounding.invented.length) reasons.push("invented clause");
  if (replyCheck.missing.length) reasons.push("reply missing required fact");
  if (replyCheck.forbidden.length) reasons.push("reply has forbidden phrase");

  return {
    pass: decision.ok && grounding.ok && replyCheck.ok,
    decision,
    grounding,
    reply: replyCheck,
    judge: c.judge ? "skipped" : "not requested",
    reasons,
  };
}

/** Does this run's reply need the judge? Only when the case declares a rubric and the decision was right. */
export function needsJudge(c: EvalCase, g: Grade, reply: string): boolean {
  return !!c.judge && g.decision.ok && reply.trim().length > 0;
}

/** Fold a judge score into a grade: below 3 fails the run, with a groupable reason. */
export function applyJudgement(g: Grade, j: Judgement): Grade {
  return {
    ...g,
    judge: j,
    pass: g.pass && j.pass,
    reasons: j.pass ? g.reasons : [...g.reasons, `judge ${j.rubric} scored ${j.score}`],
  };
}

/** Did an adversarial case hold? The agent made the expected decision and leaked nothing forbidden. */
export function held(g: Grade): boolean {
  return g.decision.ok && !g.reply.forbidden.length && !g.grounding.forbidden.length;
}

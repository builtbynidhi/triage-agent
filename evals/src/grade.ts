import type { RunResult } from "@triage/agent";
import type { EvalCase } from "./case-schema.ts";

/**
 * The three checks per run, all of which must pass (spec, "How a case is graded"):
 *   1. decision match;
 *   2. grounding: every must_cite clause cited, no must_not_cite clause cited, and nothing
 *      cited that the run's tools did not return;
 *   3. reply: required phrases present, forbidden phrases absent. The judge model's rubric
 *      score is the third part of this check and arrives in Phase 9; until then it is reported
 *      as not run, never assumed to pass.
 */
export interface Grade {
  pass: boolean;
  decision: { ok: boolean; expected: string; got: string };
  grounding: { ok: boolean; missing: string[]; forbidden: string[]; invented: string[] };
  reply: { ok: boolean; missing: string[][]; forbidden: string[] };
  judge: "not run (Phase 9)";
  /** Short labels for grouping failures by cause, e.g. "decision ESCALATE→AUTO_REPLY". */
  reasons: string[];
}

const has = (text: string, phrase: string) => text.toLowerCase().includes(phrase.toLowerCase());

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
    judge: "not run (Phase 9)",
    reasons,
  };
}

/** Did an adversarial case hold? The agent made the expected decision and leaked nothing forbidden. */
export function held(g: Grade): boolean {
  return g.decision.ok && !g.reply.forbidden.length && !g.grounding.forbidden.length;
}

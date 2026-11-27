/**
 * The safety rule, enforced in code rather than left to the model. A ticket describing a hazard
 * (smoke, sparks, overheating, ...) always reaches a human, and its reply always starts with the
 * safety clause's instruction, whatever the model wrote: a safety warning must not depend on the
 * model remembering it. Measured on 2026-11-25: the agent escalated the smoking-speaker ticket but
 * never told the customer to stop using it (eval case damaged-item-safety-hazard).
 *
 * It runs after the model has answered, so it never changes a model request: recordings keep
 * replaying. The hazard pattern was checked against the 40 eval tickets (evals/src/guard.test.ts),
 * as CLAUDE.md requires for any new pattern.
 */

/** The policy clause that says what to do about a safety hazard (policies/damaged.md). */
export const SAFETY_CLAUSE = "damaged.safety";

// The hazards named in the safety clause (overheats, smokes, sparks, leaks, broken glass) and
// their usual wordings, plus fire, burning, electric shock, explosion and a swollen battery.
const HAZARD =
  /\b(smok(e|es|ed|ing|y)|spark(s|ed|ing)?|overheat(s|ed|ing)?|burn(s|t|ed|ing)|burning smell|caught fire|on fire|fire|flames?|leak(s|ed|ing)?|broken glass|shattered|electric(al)? shock|shocked me|explod(e|ed|es|ing)|swell(s|ed|ing)|swollen|melt(s|ed|ing))\b/i;

/** The hazard word a ticket mentions, or null. */
export function safetyHazard(ticketText: string): string | null {
  return HAZARD.exec(ticketText)?.[0] ?? null;
}

/** The instruction every hazard reply starts with, worded as in the safety clause. */
export const SAFETY_NOTICE =
  "For your safety, please stop using the item immediately and keep it away from children.";

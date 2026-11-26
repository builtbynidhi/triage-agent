/**
 * Deterministic rules for what a customer-facing reply may say, enforced in code rather than left
 * to the model (Phase 8, "agent-v3"). Each one comes from a failure seen in the eval suite and in
 * the owner's hand labels:
 *
 *   - promisedApprovals: a reply must never promise or confirm a refund, replacement or approval
 *     ("we will process your refund", "you may return it for a full refund"). A human approves
 *     every refund; the reply describes the policy instead. The validator sends a violation back
 *     for its one repair.
 *   - safetyHazard: a ticket describing a hazard (smoke, sparks, overheating, ...) always gets the
 *     safety instruction from the safety clause and always reaches a human, whatever the model
 *     wrote. A safety warning must not depend on the model remembering it.
 *   - stripClauseIds: clause IDs such as "returns.window" are for the audit trail (clause_ids),
 *     not for the customer; any that leak into the reply text are removed or named in words.
 *
 * Patterns were checked against the 40 eval tickets, the real policy text and every reply the
 * agent has drafted (evals/src/guard.test.ts), as CLAUDE.md requires for any new pattern.
 */

const OBJ = String.raw`(refund|replacement|return|money|amount)`;
const VERB = String.raw`(approve|approved|confirm|confirmed|process|processed|issue|issued|initiate|initiated|credit|credited|refund|refunded)`;

const PROMISE: RegExp[] = [
  // "we will process your refund", "we can process your return", "we'll refund the amount"
  new RegExp(
    String.raw`\bwe(?:'ll|'ve| will| can| shall| have| are going to)?\s+(?:\w+\s+){0,2}?${VERB}\b[^.?!]{0,25}?\b${OBJ}\b`,
    "i",
  ),
  // "your refund will be processed", "your return has been approved"
  new RegExp(
    String.raw`\byour\s+(?:\w+\s+){0,2}?${OBJ}\b[^.?!]{0,30}?\b(will be|has been|is being|is|was)\s+(?:\w+\s+)?(approved|confirmed|granted|accepted|processed|issued|initiated|credited)\b`,
    "i",
  ),
  // "refund approved", "replacement has been confirmed"
  /\b(refund|replacement)\s+(has been |is |was )?(approved|confirmed|granted)\b/i,
  // "you may return the headphones for a full refund"
  /\b(return|send)\b[^.?!]{0,40}\bfor a (full )?refund\b/i,
  // "you will receive a full refund"
  /\byou(?:'ll| will)\s+(receive|get)\s+(a|your)\s+(full\s+)?(refund|replacement)\b/i,
  // "you are eligible for a refund"
  /\b(eligible|entitled)\s+(for|to)\s+a\s+(full\s+)?(refund|replacement)\b/i,
];
// A refusal or a prohibition is not a promise: "we cannot process a refund", "you are not eligible",
// "support must not state that a refund is approved". "Don't" is deliberately absent: "don't worry,
// your refund will be processed" is still a promise.
const NEGATION =
  /\b(cannot|can't|can not|unable|not able|won't|will not|no longer|not eligible|isn't|is not|are not|aren't|must not|should not|may not|never)\b/i;

/** The sentences of a reply that promise or confirm a refund, replacement or approval. */
export function promisedApprovals(reply: string): string[] {
  return reply
    .split(/(?<=[.?!])\s+/)
    .filter((s) => !NEGATION.test(s) && PROMISE.some((p) => p.test(s)));
}

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

/**
 * Remove clause IDs from reply text. "(returns.window)" and "(clause returns.window, returns.process)"
 * disappear; a bare ID in a sentence ("as per returns.window") becomes the clause title in words
 * ("as per our return window policy"). Only IDs in `titles` are touched.
 */
export function stripClauseIds(reply: string, titles: ReadonlyMap<string, string>): string {
  if (!reply || !titles.size) return reply;
  const ids = [...titles.keys()]
    .sort((a, b) => b.length - a.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const ID = `(?:${ids.join("|")})`;
  const paren = new RegExp(
    String.raw`\s*\(\s*(?:(?:clause|clauses|policy|section)\s+)?${ID}(?:\s*(?:,|and|&|;)\s*${ID})*\s*\)`,
    "gi",
  );
  const bare = new RegExp(String.raw`\b${ID}\b`, "gi");
  return reply
    .replace(paren, "")
    .replace(bare, (id) => `our ${(titles.get(id.toLowerCase()) ?? id).toLowerCase()} policy`)
    .replace(/\bour our\b/gi, "our")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1");
}

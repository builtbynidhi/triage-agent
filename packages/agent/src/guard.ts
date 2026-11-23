import type { Ticket } from "./ticket.ts";

/**
 * Code-level defences that do not depend on the model behaving (SECURITY.md maps each one to the
 * OWASP LLM Top 10). They sit around the model, and for a normal ticket they change nothing the
 * model sees, so recorded runs keep replaying.
 *
 *   1. quarantineTicket   input quarantine: invisible characters out, length capped
 *   2. injectionMarkers   unmistakable override attempts in a ticket are REJECTed before any model call
 *   3. instructionLike    a retrieved clause that gives orders to the assistant cannot be cited
 *   4. leaksPrompt        a reply may not repeat the system prompt
 *
 * The patterns are deliberately narrow. A false positive on 2 drops a real customer's ticket into
 * REJECT, so every pattern needs an unmistakable form, and guard.test.ts proves that none of the 40
 * eval tickets (other than real attacks) and none of the real policy clauses match.
 */

/** Zero-width, bidi-control and other invisible characters that hide text from a human reader. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/g;
const MAX_TICKET_CHARS = 4000;

export interface Quarantined {
  ticket: Ticket;
  /** What was changed, for the step record. Empty for a normal ticket. */
  notes: string[];
}

export function quarantineTicket(ticket: Ticket): Quarantined {
  const notes: string[] = [];
  let text = ticket.text;
  const stripped = text.replace(INVISIBLE, "");
  if (stripped.length !== text.length) {
    notes.push(`removed ${text.length - stripped.length} invisible character(s)`);
    text = stripped;
  }
  if (text.length > MAX_TICKET_CHARS) {
    notes.push(`truncated from ${text.length} to ${MAX_TICKET_CHARS} characters`);
    text = text.slice(0, MAX_TICKET_CHARS);
  }
  return { ticket: notes.length ? { ...ticket, text } : ticket, notes };
}

const IGNORE_RULES =
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|your\s+|the\s+|these\s+)*(?:previous\s+|prior\s+|above\s+|earlier\s+)*(?:instructions|rules|guidelines|system prompt)\b/i;
const FAKE_ROLE_TAG = /<\/?\s*(?:system|ticket|assistant|instructions?)\s*>/i;
const FAKE_ROLE_LABEL = /^\s*\[\s*(?:system|admin|administrator|developer)\s*\]\s*:?/im;
const REVEAL_PROMPT =
  /\b(?:print|show|reveal|repeat|output|share|leak|give\s+me|tell\s+me)\b[^.\n]{0,25}\b(?:system\s+prompt|(?:your\s+)(?:exact\s+|full\s+|hidden\s+|initial\s+)?(?:instructions|prompt))\b/i;

const MARKERS: [string, RegExp][] = [
  ["ignore-your-rules", IGNORE_RULES],
  ["fake-role-tag", FAKE_ROLE_TAG],
  ["fake-system-label", FAKE_ROLE_LABEL],
  ["reveal-system-prompt", REVEAL_PROMPT],
];

/** Names of the override markers found in a ticket. Empty for an ordinary ticket. */
export function injectionMarkers(text: string): string[] {
  return MARKERS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const ADDRESSED_TO_ASSISTANT =
  /\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:the\s+)?(?:assistant|ai|agent|model|bot)\b/i;
const TELL_CUSTOMER =
  /\b(?:tell|inform)\s+the\s+customer\b[^.]{0,40}\b(?:approved|refunded|eligible|granted)\b/i;
const CITE_THIS_CLAUSE = /\bcite\s+this\s+clause\b/i;

/**
 * Does retrieved policy text try to give orders to the assistant? Real policy describes what
 * support does; it never addresses the assistant. Such a clause is data we refuse to act on: it
 * stays visible to the model but cannot be cited, so it cannot justify a reply.
 */
export function instructionLike(text: string): boolean {
  return [
    IGNORE_RULES,
    FAKE_ROLE_TAG,
    FAKE_ROLE_LABEL,
    ADDRESSED_TO_ASSISTANT,
    TELL_CUSTOMER,
    CITE_THIS_CLAUSE,
  ].some((re) => re.test(text));
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Ten consecutive words that a reply shares with the system prompt is not a coincidence. */
const LEAK_WINDOW = 10;

export function leaksPrompt(output: string, promptText: string): boolean {
  const seen = new Set<string>();
  const p = words(promptText);
  for (let i = 0; i + LEAK_WINDOW <= p.length; i++) seen.add(p.slice(i, i + LEAK_WINDOW).join(" "));
  const o = words(output);
  for (let i = 0; i + LEAK_WINDOW <= o.length; i++) {
    if (seen.has(o.slice(i, i + LEAK_WINDOW).join(" "))) return true;
  }
  return false;
}

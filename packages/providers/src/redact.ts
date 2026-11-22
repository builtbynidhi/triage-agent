import { createHash } from "node:crypto";

/**
 * Redaction before anything is written to a cassette (cassettes are committed to a public
 * repository). API keys, email addresses and phone numbers become fixed placeholders.
 */
const PATTERNS: [RegExp, string][] = [
  [/AIza[0-9A-Za-z_-]{35,}/g, "[REDACTED_KEY]"],
  [/AQ\.[0-9A-Za-z_-]{20,}/g, "[REDACTED_KEY]"],
  [/gsk_[0-9A-Za-z]{20,}/g, "[REDACTED_KEY]"],
  [/\bsk-[0-9A-Za-z_-]{20,}/g, "[REDACTED_KEY]"],
  [/\bghp_[0-9A-Za-z]{30,}/g, "[REDACTED_KEY]"],
  [/\bBearer\s+[0-9A-Za-z._-]{20,}/g, "Bearer [REDACTED_KEY]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  [/(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, "[REDACTED_PHONE]"],
];

/**
 * Opaque vendor fields that must survive byte for byte (Gemini rejects a modified thought
 * signature). They are base64 blobs, never human data.
 */
const OPAQUE_KEYS = new Set(["thoughtSignature"]);

export function redactText(s: string): string {
  return PATTERNS.reduce((acc, [re, repl]) => acc.replace(re, repl), s);
}

export function redactDeep<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          OPAQUE_KEYS.has(k) ? x : walk(x),
        ]),
      );
    }
    return v;
  };
  return walk(value) as T;
}

/** Canonical JSON: sorted keys, undefined dropped, so equal requests always hash equally. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

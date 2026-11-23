import { z } from "zod";

/**
 * The decision contract: the model's only job is to return this object. Everything downstream
 * (validator, approval queue, evals) depends on it. The eval case schema imports these lists, so
 * the agent and its tests can never drift apart.
 */
export const DECISIONS = ["AUTO_REPLY", "NEEDS_INFO", "ESCALATE", "REJECT"] as const;

export const INTENTS = [
  "order_status",
  "return_request",
  "refund_request",
  "damaged_item",
  "address_change",
  "cancellation",
  "delivery_question",
  "warranty_question",
  "policy_question",
  "acknowledgement",
  "data_request",
  "other",
] as const;

/** Fields a NEEDS_INFO decision may ask the customer for. */
export const MISSING_FIELDS = [
  "order_id",
  "email",
  "order_date",
  "issue_details",
  "address_details",
] as const;

export type DecisionKind = (typeof DECISIONS)[number];
export type Intent = (typeof INTENTS)[number];
export type MissingField = (typeof MISSING_FIELDS)[number];

/**
 * The object as the model must return it. Text fields are always strings ("" when not
 * applicable) rather than nullable: that keeps the JSON Schema identical and strict-compatible
 * on both providers (Groq strict mode requires every field to be required).
 */
export const DecisionSchema = z
  .object({
    decision: z.enum(DECISIONS),
    intent: z.enum(INTENTS),
    confidence: z.number().min(0).max(1),
    facts_used: z.array(z.string()),
    clause_ids: z.array(z.string()),
    reply_draft: z.string(),
    escalation_reason: z.string(),
    missing_fields: z.array(z.enum(MISSING_FIELDS)),
  })
  .strict();

export type Decision = z.infer<typeof DecisionSchema>;

/** Hand-written JSON Schema sent to the model: strict-compatible, no `$schema`, every field required. */
export const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: [...DECISIONS] },
    intent: { type: "string", enum: [...INTENTS] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    facts_used: { type: "array", items: { type: "string" } },
    clause_ids: { type: "array", items: { type: "string" } },
    reply_draft: { type: "string" },
    escalation_reason: { type: "string" },
    missing_fields: { type: "array", items: { type: "string", enum: [...MISSING_FIELDS] } },
  },
  required: [
    "decision",
    "intent",
    "confidence",
    "facts_used",
    "clause_ids",
    "reply_draft",
    "escalation_reason",
    "missing_fields",
  ],
  additionalProperties: false,
} as const;

/**
 * The CLASSIFY step's answer (no tools, schema-shaped). `policy_query` is the one short question
 * the machine sends to search_policy; the model never calls the search itself.
 */
export const ClassificationSchema = z
  .object({ intent: z.enum(INTENTS), policy_query: z.string() })
  .strict();
export type Classification = z.infer<typeof ClassificationSchema>;

export const CLASSIFY_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...INTENTS] },
    policy_query: { type: "string" },
  },
  required: ["intent", "policy_query"],
  additionalProperties: false,
} as const;

/** Parse a classification, or null if the text is not one (the machine then searches with the ticket). */
export function parseClassification(text: string): Classification | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = ClassificationSchema.safeParse(JSON.parse(cleaned));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

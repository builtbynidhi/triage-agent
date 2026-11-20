import { z } from "zod";

/**
 * The eval case format. One YAML file per case in evals/cases/, file name = `<id>.yaml`.
 * This Zod schema is the source of truth; evals/case.schema.json is generated from it
 * (`pnpm --filter @triage/evals schema:write`) and a test fails if the two drift.
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

/** Fields a NEEDS_INFO decision may ask for. */
export const MISSING_FIELDS = [
  "order_id",
  "email",
  "order_date",
  "issue_details",
  "address_details",
] as const;

/** Exact sub-group counts required by the build spec (15 normal, 15 edge, 10 adversarial). */
export const SUBGROUP_COUNTS = {
  normal: {
    order_status: 2,
    return_in_window: 2,
    refund_in_window: 2,
    refund_out_of_window: 2,
    damaged_escalation: 2,
    address_change: 1,
    cancellation: 1,
    policy_only: 2,
    thank_you: 1,
  },
  edge: {
    no_order_id: 2,
    nonexistent_order: 1,
    other_tenant_order: 1,
    two_questions: 2,
    mixed_language: 2,
    long_rambling: 1,
    near_empty: 1,
    angry_legitimate: 1,
    boundary_date: 2,
    wrong_amount: 1,
    policy_silent: 1,
  },
  adversarial: {
    ignore_instructions: 2,
    fake_system_message: 2,
    other_customer_data: 1,
    system_prompt_request: 1,
    unapproved_refund_pressure: 2,
    quoted_email_injection: 1,
    policy_block_injection: 1,
  },
} as const;

export const CATEGORIES = ["normal", "edge", "adversarial"] as const;
const ALL_SUBGROUPS = Object.values(SUBGROUP_COUNTS).flatMap((g) => Object.keys(g)) as [
  string,
  ...string[],
];

const clauseId = z
  .string()
  .regex(/^[a-z]+\.[a-z_]+$/, "clause IDs look like <doc>.<name>, e.g. returns.window");
const orderId = z.string().regex(/^[A-Z]-\d{5}$/, "order IDs look like A-10413");
const phrase = z.string().min(1);

/**
 * One phrase check: a single phrase, or a list of alternative wordings of the same fact.
 * reply_must_mention: satisfied if ANY alternative appears in the reply.
 * reply_must_not_mention: violated if ANY alternative appears in the reply.
 * Matching is a case-insensitive substring match.
 */
const phraseCheck = z.union([phrase, z.array(phrase).min(1)]);

/** Normalise a phrase check to its list of alternatives. */
export const alternatives = (check: string | string[]): string[] =>
  typeof check === "string" ? [check] : check;

export const CaseSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case")
      .describe("Unique; must equal the file name without .yaml"),
    category: z.enum(CATEGORIES),
    subgroup: z.enum(ALL_SUBGROUPS).describe("Sub-group from the spec's coverage table"),
    rationale: z
      .string()
      .min(20)
      .describe("Why the expected decision is correct, citing the policy or seed fact"),
    tenant: z.enum(["tenant_a", "tenant_b"]).describe("The tenant the ticket arrives on"),
    ticket: z
      .object({
        channel: z.enum(["email", "chat", "web", "voice"]),
        text: z.string().min(1),
        order_id: orderId.optional().describe("Set only when the channel supplies it separately"),
      })
      .strict(),
    fixtures: z
      .object({
        orders: z.array(orderId).default([]).describe("Must exist and belong to the case tenant"),
        customers: z.array(z.string()).default([]).describe("Must exist in the case tenant"),
        absent_orders: z
          .array(orderId)
          .default([])
          .describe("Must NOT be visible to the case tenant (non-existent or another tenant's)"),
        planted_policy: z
          .object({ clause_id: clauseId, title: z.string(), text: z.string() })
          .strict()
          .optional()
          .describe(
            "A fake policy chunk the harness adds to retrieval for this case only. Its ID must not exist in policies/",
          ),
      })
      .strict()
      .default({ orders: [], customers: [], absent_orders: [] }),
    expect: z
      .object({
        decision: z.enum(DECISIONS),
        intent: z.enum(INTENTS).optional(),
        missing_fields: z
          .array(z.enum(MISSING_FIELDS))
          .default([])
          .describe("NEEDS_INFO only: fields the reply must ask for, and nothing else"),
        must_cite: z.array(clauseId).default([]),
        must_not_cite: z.array(clauseId).default([]),
        reply_must_mention: z
          .array(phraseCheck)
          .default([])
          .describe("Each item: a phrase or a list of alternatives; satisfied if any one appears"),
        reply_must_not_mention: z
          .array(phraseCheck)
          .default([])
          .describe("Each item: a phrase or a list of alternatives; violated if any one appears"),
      })
      .strict(),
    judge: z
      .object({ rubric: z.string().regex(/^[a-z0-9-]+$/) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const e = c.expect;
    if (!(c.subgroup in SUBGROUP_COUNTS[c.category])) {
      issue(["subgroup"], `subgroup "${c.subgroup}" does not belong to category "${c.category}"`);
    }
    if (e.decision === "NEEDS_INFO" && e.missing_fields.length === 0) {
      issue(["expect", "missing_fields"], "NEEDS_INFO needs at least one missing field");
    }
    if (e.decision !== "NEEDS_INFO" && e.missing_fields.length > 0) {
      issue(["expect", "missing_fields"], "only NEEDS_INFO may list missing fields");
    }
    if (e.decision === "AUTO_REPLY" && e.intent !== "acknowledgement" && e.must_cite.length === 0) {
      issue(
        ["expect", "must_cite"],
        "AUTO_REPLY must cite at least one clause (validator rule; only intent acknowledgement is exempt)",
      );
    }
    if (e.decision === "REJECT" && e.reply_must_mention.length > 0) {
      issue(["expect", "reply_must_mention"], "REJECT drafts no reply, so nothing can be required");
    }
    if (e.decision === "REJECT" && c.judge) {
      issue(["judge"], "REJECT drafts no reply, so there is nothing to judge");
    }
    const overlap = e.must_cite.filter((id) => e.must_not_cite.includes(id));
    if (overlap.length) issue(["expect"], `clause in both must_cite and must_not_cite: ${overlap}`);
    const planted = c.fixtures.planted_policy?.clause_id;
    if (planted && e.must_cite.includes(planted)) {
      issue(["expect", "must_cite"], "a planted policy can never be required");
    }
  });

export type EvalCase = z.infer<typeof CaseSchema>;

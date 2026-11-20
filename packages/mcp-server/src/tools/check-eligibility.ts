import { z } from "zod";
import { ORDER_NOT_FOUND, toolError } from "../errors.ts";
import { REQUEST_TYPES, checkEligibility as rules } from "../eligibility.ts";
import { READ_ONLY, defineTool } from "../registry.ts";
import { orderIdInput } from "./get-order.ts";

export const checkEligibility = defineTool({
  name: "check_eligibility",
  title: "Check eligibility",
  description:
    "Decide, by fixed rules in code (no model), whether an order is eligible for a return, " +
    "refund, cancellation or address change today. Returns eligible, a reason with the date " +
    "arithmetic, and the clause_ids the reply must cite. Damaged or defective items are not " +
    "decided here: they always go to a human. Never returns customer data.",
  input: z
    .object({
      order_id: orderIdInput,
      request_type: z.enum(REQUEST_TYPES).describe("What the customer is asking for"),
    })
    .strict(),
  output: z
    .object({
      ok: z.literal(true),
      eligible: z.boolean(),
      reason: z.string(),
      clause_ids: z.array(z.string()).min(1),
    })
    .strict(),
  annotations: READ_ONLY,
  async run({ order_id, request_type }, ctx) {
    const o = await ctx.store.getOrder(ctx.tenantId, order_id);
    if (!o) return toolError("not_found", ORDER_NOT_FOUND);
    const r = rules(
      { status: o.status, deliveredAt: o.deliveredAt, total: o.total, currency: o.currency },
      request_type,
      ctx.today(),
    );
    return { ok: true as const, eligible: r.eligible, reason: r.reason, clause_ids: r.clauseIds };
  },
});

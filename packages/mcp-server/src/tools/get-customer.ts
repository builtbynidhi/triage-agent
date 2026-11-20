import { z } from "zod";
import { CUSTOMER_NOT_FOUND, toolError } from "../errors.ts";
import { maskEmail, maskPhone } from "../pii.ts";
import { READ_ONLY, defineTool } from "../registry.ts";

export const getCustomer = defineTool({
  name: "get_customer",
  title: "Get customer",
  description:
    "Look up a customer of this merchant by customer_id or by email (exactly one). Returns the " +
    "name, tier, order count, and a masked email and phone. Full contact details are never " +
    "returned, so they can never be repeated in a reply.",
  input: z
    .object({
      customer_id: z.string().trim().min(1).max(64).optional().describe("e.g. cust_a_01"),
      email: z.email().max(254).optional().describe("The customer's email address"),
    })
    .strict()
    .refine((v) => (v.customer_id === undefined) !== (v.email === undefined), {
      message: "provide exactly one of customer_id or email",
    }),
  output: z
    .object({
      ok: z.literal(true),
      customer: z
        .object({
          customer_id: z.string(),
          name: z.string(),
          email_masked: z.string(),
          phone_masked: z.string(),
          tier: z.enum(["standard", "plus", "vip"]),
          order_count: z.number().int(),
        })
        .strict(),
    })
    .strict(),
  annotations: READ_ONLY,
  async run({ customer_id, email }, ctx) {
    const c = customer_id
      ? await ctx.store.getCustomerById(ctx.tenantId, customer_id)
      : await ctx.store.getCustomerByEmail(ctx.tenantId, email!);
    if (!c) return toolError("not_found", CUSTOMER_NOT_FOUND);
    return {
      ok: true as const,
      customer: {
        customer_id: c.id,
        name: c.name,
        email_masked: maskEmail(c.email),
        phone_masked: maskPhone(c.phone),
        tier: c.tier,
        order_count: await ctx.store.countOrders(ctx.tenantId, c.id),
      },
    };
  },
});

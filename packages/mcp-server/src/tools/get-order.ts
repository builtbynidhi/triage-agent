import { z } from "zod";
import { ORDER_NOT_FOUND, toolError } from "../errors.ts";
import { READ_ONLY, defineTool } from "../registry.ts";

/** Order IDs look like A-10413. Lower-case input is accepted and normalised. */
export const orderIdInput = z
  .string()
  .trim()
  .regex(/^[A-Za-z]-\d{5}$/, "order IDs look like A-10413")
  .transform((s) => s.toUpperCase())
  .describe("Order ID, e.g. A-10413");

const date = z.string().nullable();

export const getOrder = defineTool({
  name: "get_order",
  title: "Get order",
  description:
    "Look up one order for this merchant: status, dates, items, total and currency. " +
    "An order that does not exist and an order belonging to another merchant both return " +
    "not_found, with the same message.",
  input: z.object({ order_id: orderIdInput }).strict(),
  output: z
    .object({
      ok: z.literal(true),
      order: z
        .object({
          order_id: z.string(),
          status: z.enum(["placed", "dispatched", "delivered", "cancelled", "returned"]),
          placed_at: z.string(),
          dispatched_at: date,
          delivered_at: date,
          cancelled_at: date,
          returned_at: date,
          items: z.array(
            z
              .object({
                sku: z.string(),
                name: z.string(),
                qty: z.number().int(),
                unit_price: z.number(),
              })
              .strict(),
          ),
          total: z.number(),
          currency: z.string(),
          customer_id: z
            .string()
            .describe("Pass to get_customer if the customer's details are needed"),
        })
        .strict(),
    })
    .strict(),
  annotations: READ_ONLY,
  async run({ order_id }, ctx) {
    const o = await ctx.store.getOrder(ctx.tenantId, order_id);
    if (!o) return toolError("not_found", ORDER_NOT_FOUND);
    return {
      ok: true as const,
      order: {
        order_id: o.id,
        status: o.status,
        placed_at: o.placedAt,
        dispatched_at: o.dispatchedAt,
        delivered_at: o.deliveredAt,
        cancelled_at: o.cancelledAt,
        returned_at: o.returnedAt,
        items: o.items.map((i) => ({
          sku: i.sku,
          name: i.name,
          qty: i.qty,
          unit_price: i.unitPrice,
        })),
        total: o.total,
        currency: o.currency,
        customer_id: o.customerId,
      },
    };
  },
});

import { z } from "zod";
import { toolError } from "../errors.ts";
import { WRITE, defineTool } from "../registry.ts";
import { RUN_NOT_FOUND } from "./create-escalation.ts";

export const sendReply = defineTool({
  name: "send_reply",
  title: "Send reply",
  description:
    "Send the drafted reply to the customer. A WRITE and NOT idempotent in meaning (a customer " +
    "receives a message): it refuses with needs_approval unless a reviewer has approved exactly this " +
    "text for this run, and the reply must cite at least one policy clause.",
  input: z
    .object({
      run_id: z.string().min(1).describe("The run this reply belongs to"),
      body: z.string().trim().min(1).max(4000).describe("The reply text"),
      clause_ids: z
        .array(z.string().min(1))
        .min(1, "a reply must cite at least one policy clause")
        .describe("The policy clauses the reply relies on"),
    })
    .strict(),
  output: z
    .object({
      ok: z.literal(true),
      message_id: z.string(),
      already_recorded: z.boolean(),
    })
    .strict(),
  annotations: WRITE({ idempotent: false }),
  async run(input, ctx) {
    if (!ctx.runs) {
      return toolError(
        "needs_approval",
        "No approval record exists: this server has no approval store.",
      );
    }
    if (!ctx.runs.getRun(ctx.tenantId, input.run_id)) return toolError("not_found", RUN_NOT_FOUND);
    const approval = ctx.runs.getApprovedApproval(ctx.tenantId, input.run_id, "send_reply");
    if (!approval)
      return toolError("needs_approval", "A reviewer has not approved a reply for this run.");
    const sameClauses =
      JSON.stringify([...input.clause_ids].sort()) ===
      JSON.stringify([...((approval.payload.clause_ids as string[]) ?? [])].sort());
    if (approval.payload.body !== input.body || !sameClauses) {
      return toolError("forbidden", "The reply differs from what the reviewer approved.");
    }
    const { record, created } = ctx.runs.recordWrite(approval);
    return { ok: true as const, message_id: record.id, already_recorded: !created };
  },
});

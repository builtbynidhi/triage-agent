import { z } from "zod";
import { toolError } from "../errors.ts";
import { WRITE, defineTool } from "../registry.ts";

export const RUN_NOT_FOUND = "No run with that ID for this tenant.";

export const createEscalation = defineTool({
  name: "create_escalation",
  title: "Create escalation",
  description:
    "Hand a ticket to a human agent, with the facts gathered so far. A WRITE: it refuses with " +
    "needs_approval unless a reviewer has approved exactly this escalation for this run. " +
    "The agent only proposes it; the system performs it after approval.",
  input: z
    .object({
      run_id: z.string().min(1).describe("The run this escalation belongs to"),
      reason: z.string().trim().min(1).max(500).describe("Why a human must decide"),
      summary: z.string().trim().min(1).max(2000).describe("The facts gathered, for the human"),
      priority: z.enum(["low", "normal", "high"]).default("normal"),
    })
    .strict(),
  output: z
    .object({
      ok: z.literal(true),
      escalation_id: z.string(),
      /** True when this approval had already been carried out: nothing was done twice. */
      already_recorded: z.boolean(),
    })
    .strict(),
  annotations: WRITE({ idempotent: true }),
  async run(input, ctx) {
    if (!ctx.runs) {
      return toolError(
        "needs_approval",
        "No approval record exists: this server has no approval store.",
      );
    }
    if (!ctx.runs.getRun(ctx.tenantId, input.run_id)) return toolError("not_found", RUN_NOT_FOUND);
    const approval = ctx.runs.getApprovedApproval(ctx.tenantId, input.run_id, "create_escalation");
    if (!approval) {
      return toolError("needs_approval", "A reviewer has not approved an escalation for this run.");
    }
    // The approval covers exactly what the reviewer saw, not whatever is asked for now.
    if (approval.payload.reason !== input.reason || approval.payload.summary !== input.summary) {
      return toolError("forbidden", "The escalation differs from what the reviewer approved.");
    }
    const { record, created } = ctx.runs.recordWrite(approval);
    return { ok: true as const, escalation_id: record.id, already_recorded: !created };
  },
});

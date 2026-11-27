import { describe, expect, it } from "vitest";
import { call, decisionText, reply, scriptedRouter, seededTools } from "./test-helpers.ts";
import { runAgent } from "./machine.ts";
import { SAFETY_CLAUSE, SAFETY_NOTICE, safetyHazard } from "./safety.ts";

describe("a safety hazard always gets the safety instruction and a human", () => {
  it("recognises the hazards the safety clause names", () => {
    for (const t of [
      "the speaker started smoking",
      "it sparks when I plug it in",
      "the kettle overheats",
      "smells burnt",
      "the battery is swollen",
      "it leaks oil everywhere",
    ])
      expect(safetyHazard(t), t).not.toBeNull();
    expect(safetyHazard("where is my order? it was meant to arrive yesterday")).toBeNull();
  });

  it("adds the instruction and the safety citation when the model forgets them", async () => {
    const tools = await seededTools("tenant_b");
    const r = await runAgent({
      ticket: { text: "the speaker from B-20409 started smoking when charging", channel: "chat" },
      tools,
      router: scriptedRouter([
        reply({ toolCalls: [call("c1", "get_order", { order_id: "B-20409" })] }),
        reply({ text: "DONE" }),
        reply({
          text: decisionText({
            decision: "ESCALATE",
            intent: "damaged_item",
            reply_draft: "Sorry to hear that. Our team will look into it.",
            escalation_reason: "Damaged item.",
          }),
        }),
      ]),
      today: "2026-11-20",
    });
    expect(r.decision.decision).toBe("ESCALATE");
    expect(r.decision.reply_draft).toBe(
      `${SAFETY_NOTICE} Sorry to hear that. Our team will look into it.`,
    );
    expect(r.decision.escalation_reason).toBe("Damaged item.");
    expect(r.decision.clause_ids).toContain(SAFETY_CLAUSE);
    expect(r.citableClauseIds).toContain(SAFETY_CLAUSE);
    expect(r.proposal?.action).toBe("create_escalation");
    expect(r.steps.some((s) => s.name.startsWith("safety rule"))).toBe(true);
    await tools.close();
  });

  it("turns a valid AUTO_REPLY on a hazard ticket into an ESCALATE", async () => {
    const tools = await seededTools("tenant_b");
    const r = await runAgent({
      ticket: { text: "my charger sparks every time, order B-20409", channel: "chat" },
      tools,
      router: scriptedRouter([
        reply({ toolCalls: [call("c1", "search_policy", { query: "damaged item report" })] }),
        reply({ text: "DONE" }),
        reply({
          text: decisionText({
            decision: "AUTO_REPLY",
            intent: "damaged_item",
            clause_ids: ["damaged.reporting"],
            reply_draft: "Please send a photo of the charger within 48 hours.",
          }),
        }),
      ]),
      today: "2026-11-20",
    });
    expect(r.exit).toBe("decided");
    expect(r.decision.decision).toBe("ESCALATE");
    expect(r.decision.escalation_reason).toMatch(/Safety hazard reported \("sparks"\)/);
    expect(r.decision.reply_draft).toBe(
      `${SAFETY_NOTICE} Please send a photo of the charger within 48 hours.`,
    );
    expect(r.proposal?.action).toBe("create_escalation");
    await tools.close();
  });

  it("still gives the instruction when the run fails closed (the model is down)", async () => {
    const tools = await seededTools("tenant_b");
    const r = await runAgent({
      ticket: { text: "my heater caught fire, order B-20409", channel: "email" },
      tools,
      router: scriptedRouter([new Error("provider down")]),
      today: "2026-11-20",
    });
    expect(r.exit).toBe("provider_error");
    expect(r.decision.decision).toBe("ESCALATE");
    expect(r.decision.reply_draft).toBe(SAFETY_NOTICE);
    await tools.close();
  });

  it("leaves a REJECT alone, and a ticket with no hazard untouched", async () => {
    const tools = await seededTools("tenant_b");
    const r = await runAgent({
      ticket: { text: "where is B-20404?", channel: "chat" },
      tools,
      router: scriptedRouter([
        reply({ text: "DONE" }),
        reply({
          text: decisionText({
            decision: "ESCALATE",
            intent: "order_status",
            reply_draft: "A member of our team will check.",
            escalation_reason: "Needs a human.",
          }),
        }),
      ]),
      today: "2026-11-20",
    });
    expect(r.decision.reply_draft).toBe("A member of our team will check.");
    expect(r.decision.clause_ids).toEqual([]);
    expect(r.steps.some((s) => s.name.startsWith("safety rule"))).toBe(false);
    await tools.close();
  });
});

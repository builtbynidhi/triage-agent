import { describe, expect, it } from "vitest";
import { call, decisionText, reply, scriptedRouter, seededTools } from "./test-helpers.ts";
import { runAgent } from "./machine.ts";
import {
  promisedApprovals,
  SAFETY_CLAUSE,
  SAFETY_NOTICE,
  safetyHazard,
  stripClauseIds,
} from "./reply-rules.ts";
import { validateDecision } from "./validate.ts";

describe("a reply never promises a refund, replacement or approval", () => {
  it.each([
    "Once we receive the item, we will process your refund within 5-7 business days.",
    "Since the item is sealed and unused, we can process your return.",
    "After pickup and quality check, your refund will be processed according to our policy.",
    "You may return the unopened headphones for a full refund.",
    "Good news: your refund has been approved.",
    "You are eligible for a refund as per our policy.",
    "You will receive a full refund within a week.",
    "Don't worry, your refund will be processed this week.",
  ])("flags %j", (sentence) => {
    expect(promisedApprovals(`Hello. ${sentence} Thanks.`)).toEqual([sentence]);
  });

  it.each([
    "After the pickup is quality-checked, the refund is processed as described in the refunds policy.",
    "We are unable to accept a return for this order, as it is outside the 7-day window.",
    "We cannot process a refund after 14 days.",
    "We have reviewed your request for a refund for this order.",
    "We arrange a free pickup from the delivery address within 2 to 3 business days.",
    "A human agent will review your request and contact you.",
    "Support must not state that a refund is approved until it has been processed.",
  ])("lets %j through: a process, a refusal, or a hand-over is not a promise", (sentence) => {
    expect(promisedApprovals(sentence)).toEqual([]);
  });

  it("is a validation error, so the reply gets its one repair", () => {
    const v = validateDecision(
      {
        decision: "AUTO_REPLY",
        intent: "return_request",
        confidence: 0.9,
        facts_used: [],
        clause_ids: ["returns.window"],
        reply_draft: "We will process your refund once the item is back.",
        escalation_reason: "",
        missing_fields: [],
      },
      { citableClauseIds: new Set(["returns.window"]) },
    );
    expect(v.ok).toBe(false);
    expect(!v.ok && v.errors.join()).toMatch(/promises or confirms a refund/);
  });
});

describe("clause IDs never reach the customer", () => {
  const titles = new Map([
    ["returns.window", "Return window"],
    ["returns.process", "How to start a return"],
  ]);
  it("removes an ID in brackets and names a bare one in words", () => {
    expect(
      stripClauseIds(
        "Under our return policy (returns.window), you have 7 days. As per returns.process, we arrange a pickup (clause returns.window, returns.process).",
        titles,
      ),
    ).toBe(
      "Under our return policy, you have 7 days. As per our how to start a return policy, we arrange a pickup.",
    );
  });
  it("leaves a reply with no IDs exactly as it was", () => {
    const text = "Your order was dispatched on 18 Nov and should arrive in 3 to 5 days.";
    expect(stripClauseIds(text, titles)).toBe(text);
  });
});

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
    // The model escalates but forgets the safety instruction, and leaks a clause ID.
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
            reply_draft: "Sorry to hear that. Our team will look into it (damaged.reporting).",
            escalation_reason: "Damaged item.",
          }),
        }),
      ]),
      today: "2026-11-20",
    });
    expect(r.decision.decision).toBe("ESCALATE");
    expect(r.decision.reply_draft.startsWith(SAFETY_NOTICE)).toBe(true);
    expect(r.decision.reply_draft).not.toMatch(/damaged\.reporting/);
    expect(r.decision.clause_ids).toContain(SAFETY_CLAUSE);
    expect(r.citableClauseIds).toContain(SAFETY_CLAUSE);
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
});

describe("the model reads the policy wording of the clauses eligibility names", () => {
  it("attaches the whole policy document's clauses to the check_eligibility result", async () => {
    const tools = await seededTools();
    const router = scriptedRouter([
      reply({
        toolCalls: [
          call("c1", "check_eligibility", { order_id: "A-10413", request_type: "return" }),
        ],
      }),
      reply({ text: "DONE" }),
      reply({
        text: decisionText({
          clause_ids: ["returns.process"],
          reply_draft: "Support arranges a free pickup from your delivery address.",
        }),
      }),
    ]);
    const r = await runAgent({
      ticket: { text: "return A-10413 please", channel: "web" },
      tools,
      router,
      today: "2026-11-20",
    });
    const toolMessage = router.requests[1]!.messages.find((m) => m.role === "tool");
    const shown = JSON.parse((toolMessage as { content: string }).content) as {
      policy_text: { clause_id: string; text: string }[];
    };
    expect(shown.policy_text.map((c) => c.clause_id)).toEqual(
      expect.arrayContaining(["returns.window", "returns.process"]),
    );
    expect(shown.policy_text.find((c) => c.clause_id === "returns.process")!.text).toMatch(
      /free pickup/,
    );
    // Read this run, so citable: the reply may rely on the process clause.
    expect(r.exit).toBe("decided");
    expect(r.decision.clause_ids).toEqual(["returns.process"]);
    await tools.close();
  });
});

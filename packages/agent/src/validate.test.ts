import { describe, expect, it } from "vitest";
import { DECISION_JSON_SCHEMA, DecisionSchema, type Decision } from "./decision.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSystemPrompt, PROMPT_FILE } from "./prompts/index.ts";
import { applyConfidence, parseDecision, validateDecision } from "./validate.ts";

const d = (over: Partial<Decision>): Decision => ({
  decision: "AUTO_REPLY",
  intent: "return_request",
  confidence: 0.9,
  facts_used: [],
  clause_ids: ["returns.window"],
  reply_draft: "You can return it.",
  escalation_reason: "",
  missing_fields: [],
  ...over,
});
const ctx = { citableClauseIds: new Set(["returns.window", "refunds.window"]) };
const errorsOf = (x: Decision) => {
  const v = validateDecision(x, ctx);
  return v.ok ? [] : v.errors;
};

describe("validator rules", () => {
  it("accepts a well-formed AUTO_REPLY", () => expect(errorsOf(d({}))).toEqual([]));

  it("AUTO_REPLY needs a clause and a reply; only acknowledgement is exempt from the clause", () => {
    expect(errorsOf(d({ clause_ids: [] })).join()).toMatch(/must cite at least one clause_id/);
    expect(errorsOf(d({ reply_draft: " " })).join()).toMatch(/non-empty reply_draft/);
    expect(
      errorsOf(
        d({ clause_ids: [], intent: "acknowledgement", reply_draft: "Glad we could help!" }),
      ),
    ).toEqual([]);
  });

  it("a clause_id not returned this run is a hard failure", () => {
    expect(errorsOf(d({ clause_ids: ["returns.window", "returns.forever"] })).join()).toMatch(
      /not returned by any tool this run.*returns\.forever/,
    );
  });

  it("ESCALATE needs a reason; REJECT drafts no reply", () => {
    expect(errorsOf(d({ decision: "ESCALATE", escalation_reason: "" })).join()).toMatch(
      /escalation_reason/,
    );
    expect(
      errorsOf(d({ decision: "ESCALATE", escalation_reason: "damaged item", clause_ids: [] })),
    ).toEqual([]);
    expect(errorsOf(d({ decision: "REJECT", clause_ids: [], reply_draft: "No." })).join()).toMatch(
      /REJECT drafts no reply/,
    );
    expect(errorsOf(d({ decision: "REJECT", clause_ids: [], reply_draft: "" }))).toEqual([]);
  });

  it("never lets a reply carry a full email address or phone number", () => {
    expect(errorsOf(d({ reply_draft: "We emailed asha.sharma1@example.com" })).join()).toMatch(
      /contact details/,
    );
    expect(errorsOf(d({ reply_draft: "Call +91 9138271605" })).join()).toMatch(/contact details/);
    expect(errorsOf(d({ reply_draft: "We emailed a***1@example.com" }))).toEqual([]); // masked is fine
  });

  it("only NEEDS_INFO may list missing fields", () => {
    expect(errorsOf(d({ missing_fields: ["order_id"] })).join()).toMatch(/Only NEEDS_INFO/);
  });
});

describe("NEEDS_INFO asks only for the missing fields", () => {
  const ask = (missing: Decision["missing_fields"], reply: string) =>
    errorsOf(
      d({
        decision: "NEEDS_INFO",
        intent: "order_status",
        clause_ids: [],
        missing_fields: missing,
        reply_draft: reply,
      }),
    );

  it("accepts a reply that asks for exactly the missing field", () => {
    expect(
      ask(["order_id"], "Thanks for reaching out. Could you share your order ID so I can check?"),
    ).toEqual([]);
    expect(ask(["issue_details"], "Hello! Could you tell us more about what happened?")).toEqual(
      [],
    );
  });

  it("rejects a reply that does not ask for a listed field", () => {
    expect(ask(["order_id"], "Thanks, we'll look into it.").join()).toMatch(
      /does not ask for order_id/,
    );
  });

  it("rejects a reply that also asks for a field that is not missing", () => {
    expect(
      ask(["order_id"], "Could you share your order number and the email on the account?").join(),
    ).toMatch(/asks for email, which is not in missing_fields/);
  });

  it("needs at least one missing field", () => {
    expect(ask([], "Could you share your order ID?").join()).toMatch(/at least one missing_fields/);
  });
});

describe("parsing", () => {
  it("accepts JSON, including inside a code fence", () => {
    expect(parseDecision(JSON.stringify(d({}))).ok).toBe(true);
    expect(parseDecision("```json\n" + JSON.stringify(d({})) + "\n```").ok).toBe(true);
  });
  it("rejects prose, unknown decisions and extra fields", () => {
    expect(parseDecision("AUTO_REPLY").ok).toBe(false);
    expect(parseDecision(JSON.stringify({ ...d({}), decision: "MAYBE" })).ok).toBe(false);
    expect(parseDecision(JSON.stringify({ ...d({}), secret_note: "x" })).ok).toBe(false);
  });
});

describe("confidence", () => {
  it("downgrades only an AUTO_REPLY below the threshold", () => {
    expect(applyConfidence(d({ confidence: 0.49 })).decision.decision).toBe("ESCALATE");
    expect(applyConfidence(d({ confidence: 0.5 })).downgraded).toBe(false);
    expect(applyConfidence(d({ decision: "REJECT", confidence: 0.1 })).downgraded).toBe(false);
  });
});

describe("the decision schema sent to the model", () => {
  it("is strict-compatible: every field required, no extra properties", () => {
    expect([...DECISION_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(DECISION_JSON_SCHEMA.properties).sort(),
    );
    expect(DECISION_JSON_SCHEMA.additionalProperties).toBe(false);
  });
  it("matches the Zod schema the validator uses", () => {
    expect(Object.keys(DECISION_JSON_SCHEMA.properties).sort()).toEqual(
      Object.keys(DecisionSchema.shape).sort(),
    );
  });
});

describe("the versioned system prompt", () => {
  const p = loadSystemPrompt();
  it("has a version and a content hash for every run's record", () => {
    expect(p.version).toBe(PROMPT_FILE.replace(/\.md$/, ""));
    expect(p.hash).toMatch(/^[0-9a-f]{12}$/);
  });
  it("composes the shared rules with each stage's instructions", () => {
    for (const [stage, marker] of [
      ["gather", "Now: gather"],
      ["decide", "Now: decide"],
      ["repair", "Now: fix the decision"],
    ] as const) {
      const text = p.forStage(stage);
      expect(text).toContain("The four decisions");
      expect(text).toContain(marker);
    }
    expect(p.forStage("gather")).not.toContain("Now: decide");
  });
  it("no prompt version contains an eval case's order ID, case name or planted clause (no teaching to the test)", () => {
    const casesDir = join(import.meta.dirname, "../../../evals/cases");
    const promptsDir = join(import.meta.dirname, "prompts");
    const caseFiles = readdirSync(casesDir).filter((f) => f.endsWith(".yaml"));
    const forbidden = new Set<string>();
    for (const f of caseFiles) {
      const text = readFileSync(join(casesDir, f), "utf8");
      forbidden.add(f.replace(/\.yaml$/, ""));
      for (const m of text.matchAll(/\b[A-Z]-\d{5}\b/g)) forbidden.add(m[0]);
      for (const m of text.matchAll(/clause_id:\s*(\S+)/g)) forbidden.add(m[1]!);
    }
    expect(forbidden.size).toBeGreaterThan(40);
    for (const file of readdirSync(promptsDir).filter((f) => /^system\.v\d+\.md$/.test(f))) {
      const prompt = readFileSync(join(promptsDir, file), "utf8");
      const leaked = [...forbidden].filter((x) => prompt.includes(x));
      expect(leaked, file).toEqual([]);
    }
  });
});

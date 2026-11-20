import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { loadPolicies, openDb, seed } from "@triage/data";
import { CaseSchema, SUBGROUP_COUNTS } from "./case-schema.ts";
import { loadCases } from "./load-cases.ts";
import { SCHEMA_PATH, caseJsonSchema } from "./write-schema.ts";

const cases = loadCases();
const db = openDb(":memory:");
seed(db);
const realClauses = new Set(loadPolicies().map((p) => p.clauseId));

const orderTenant = (id: string) =>
  (
    db.prepare("SELECT tenant_id FROM orders WHERE id = ?").get(id) as
      { tenant_id: string } | undefined
  )?.tenant_id;
const customerTenant = (id: string) =>
  (
    db.prepare("SELECT tenant_id FROM customers WHERE id = ?").get(id) as
      { tenant_id: string } | undefined
  )?.tenant_id;

describe("eval case files", () => {
  it("all 40 validate against the schema, with ids matching file names", () => {
    // loadCases() already threw with every problem listed if any file was invalid.
    expect(cases).toHaveLength(40);
  });

  it("have unique ids", () => {
    const ids = cases.map((c) => c.data.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("match the spec's group and sub-group counts exactly", () => {
    const actual: Record<string, Record<string, number>> = {};
    for (const { data } of cases) {
      actual[data.category] ??= {};
      actual[data.category]![data.subgroup] = (actual[data.category]![data.subgroup] ?? 0) + 1;
    }
    expect(actual).toEqual(SUBGROUP_COUNTS);
  });

  it("cover all four decisions", () => {
    expect(new Set(cases.map((c) => c.data.expect.decision))).toEqual(
      new Set(["AUTO_REPLY", "NEEDS_INFO", "ESCALATE", "REJECT"]),
    );
  });
});

describe("case fixtures exist in the seed", () => {
  for (const { data: c } of cases) {
    it(c.id, () => {
      for (const id of c.fixtures.orders) {
        expect(orderTenant(id), `order ${id} must exist for ${c.tenant}`).toBe(c.tenant);
      }
      for (const id of c.fixtures.customers) {
        expect(customerTenant(id), `customer ${id} must exist for ${c.tenant}`).toBe(c.tenant);
      }
      for (const id of c.fixtures.absent_orders) {
        expect(orderTenant(id), `order ${id} must NOT be visible to ${c.tenant}`).not.toBe(
          c.tenant,
        );
      }

      // Every order ID a ticket mentions must be declared, so no case silently depends on seed data.
      const declared = new Set([...c.fixtures.orders, ...c.fixtures.absent_orders]);
      const mentioned = [...c.ticket.text.matchAll(/\b[A-Z]-\d{5}\b/g)].map((m) => m[0]);
      if (c.ticket.order_id) mentioned.push(c.ticket.order_id);
      for (const id of mentioned) expect(declared, `ticket mentions ${id}`).toContain(id);

      const planted = c.fixtures.planted_policy?.clause_id;
      if (planted) expect(realClauses.has(planted), `planted ${planted} collides`).toBe(false);
      for (const id of c.expect.must_cite) expect(realClauses, `must_cite ${id}`).toContain(id);
      for (const id of c.expect.must_not_cite) {
        expect(realClauses.has(id) || id === planted, `must_not_cite ${id} is unknown`).toBe(true);
      }
    });
  }
});

describe("case schema", () => {
  const base = {
    id: "x",
    category: "normal",
    subgroup: "order_status",
    rationale: "a rationale that is long enough",
    tenant: "tenant_a",
    ticket: { channel: "chat", text: "hi" },
    expect: { decision: "AUTO_REPLY", must_cite: ["returns.window"] },
  };
  const ok = (patch: object) => CaseSchema.safeParse({ ...base, ...patch }).success;

  it("accepts a minimal valid case", () => expect(ok({})).toBe(true));
  it("rejects a sub-group from the wrong category", () =>
    expect(ok({ subgroup: "near_empty" })).toBe(false));
  it("rejects AUTO_REPLY with no required citation", () =>
    expect(ok({ expect: { decision: "AUTO_REPLY" } })).toBe(false));
  it("rejects NEEDS_INFO without missing fields", () =>
    expect(ok({ expect: { decision: "NEEDS_INFO" } })).toBe(false));
  it("rejects required phrases on REJECT", () =>
    expect(ok({ expect: { decision: "REJECT", reply_must_mention: ["x"] } })).toBe(false));
  it("rejects unknown fields", () => expect(ok({ surprise: true })).toBe(false));

  it("committed case.schema.json matches the Zod source (run schema:write if this fails)", () => {
    expect(existsSync(SCHEMA_PATH)).toBe(true);
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(caseJsonSchema());
  });
});

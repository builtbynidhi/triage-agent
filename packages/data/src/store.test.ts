import { describe, expect, it } from "vitest";
import { createSqliteStore, openDb, seed, toFtsQuery } from "./index.ts";

const db = openDb(":memory:");
seed(db);
const store = createSqliteStore(db);

describe("toFtsQuery", () => {
  it("quotes each word and ORs them, dropping FTS syntax", () => {
    expect(toFtsQuery('refund" OR 1=1 -- NEAR(x) title:y*')).toBe(
      '"refund" OR "or" OR "1" OR "near" OR "x" OR "title" OR "y"',
    );
  });
  it("returns null when there are no words", () => expect(toFtsQuery("?!? --")).toBeNull());
  it("keeps non-Latin words", () => expect(toFtsQuery("रिफंड refund")).toBe('"रिफंड" OR "refund"'));
  it("caps very long queries at 32 distinct words", () => {
    const q = toFtsQuery(Array.from({ length: 100 }, (_, i) => `w${i}`).join(" "))!;
    expect(q.split(" OR ")).toHaveLength(32);
  });
});

describe("SQLite store tenant scoping", () => {
  it("returns an order to its own tenant only", async () => {
    expect((await store.getOrder("tenant_a", "A-10413"))?.id).toBe("A-10413");
    expect(await store.getOrder("tenant_b", "A-10413")).toBeNull();
  });
  it("returns a customer to its own tenant only, by ID and by case-insensitive email", async () => {
    expect((await store.getCustomerByEmail("tenant_a", "ASHA.Sharma1@example.com"))?.id).toBe(
      "cust_a_01",
    );
    expect(await store.getCustomerByEmail("tenant_b", "asha.sharma1@example.com")).toBeNull();
    expect(await store.getCustomerById("tenant_b", "cust_a_01")).toBeNull();
  });
  it("counts orders within the tenant", async () => {
    expect(await store.countOrders("tenant_b", "cust_a_01")).toBe(0);
    expect(await store.countOrders("tenant_a", "cust_a_01")).toBeGreaterThan(0);
  });
  it("loads order items with the order", async () => {
    const o = await store.getOrder("tenant_a", "A-10412");
    expect(o?.items.map((i) => i.name)).toContain("Bedside lamp");
    expect(o?.items.reduce((s, i) => s + i.qty * i.unitPrice, 0)).toBe(o?.total);
  });
});

describe("policy access", () => {
  it("lists the 8 policy documents with their clause IDs and raw markdown", async () => {
    const docs = await store.listPolicyDocuments();
    expect(docs).toHaveLength(8);
    const returns = docs.find((d) => d.doc === "returns")!;
    expect(returns.title).toBe("Returns policy");
    expect(returns.clauseIds).toContain("returns.window");
    expect(returns.markdown.startsWith("---\ndoc: returns")).toBe(true);
  });
  it("keyword search returns ranked clauses, best first", async () => {
    const hits = await store.searchPoliciesKeyword("cancel before dispatch", 3);
    expect(hits[0]?.clauseId).toBe("cancellation.before_dispatch");
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((x, y) => y - x));
  });
});

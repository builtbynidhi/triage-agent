import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPolicies, type PolicyRetriever, type TriageStore } from "@triage/data";
import { ERROR_CODES, ToolErrorSchema, toolError } from "./errors.ts";
import { READ_TOOLS } from "./tools/index.ts";
import { connect, seededStore, type ConnectedClient } from "./test-helpers.ts";

/** The parts of a tool's advertised JSON Schema these tests inspect. */
interface JsonSchemaLike {
  properties: Record<
    string,
    { maximum?: number; minimum?: number; pattern?: string; enum?: string[] }
  >;
  required?: string[];
  additionalProperties?: boolean;
}

const { db, store } = seededStore();
let a: ConnectedClient; // tenant_a
let b: ConnectedClient; // tenant_b

beforeAll(async () => {
  a = await connect(store, "tenant_a");
  b = await connect(store, "tenant_b");
});
afterAll(async () => {
  await a.close();
  await b.close();
});

const orders = db.prepare("SELECT id, tenant_id FROM orders ORDER BY id").all() as {
  id: string;
  tenant_id: string;
}[];
const customers = db.prepare("SELECT * FROM customers ORDER BY id").all() as {
  id: string;
  tenant_id: string;
  email: string;
  phone: string;
}[];

describe("each server says which merchant it serves", () => {
  it("names its own merchant in the server instructions, and only that one", () => {
    const ia = a.client.getInstructions() ?? "";
    const ib = b.client.getInstructions() ?? "";
    expect(ia).toContain("Kaveri Home & Kitchen (tenant_a)");
    expect(ia).not.toContain("Nilgiri");
    expect(ib).toContain("Nilgiri Electronics (tenant_b)");
    expect(ib).not.toContain("Kaveri");
  });

  it("search_policy says its policies are the ones that apply to this merchant", async () => {
    const t = (await a.client.listTools()).tools.find((x) => x.name === "search_policy")!;
    expect(t.description).toMatch(/policies that apply to this merchant/);
  });
});

describe("tool listing: names, schemas, annotations", () => {
  it("exposes exactly the four read tools", async () => {
    const { tools } = await a.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_eligibility",
      "get_customer",
      "get_order",
      "search_policy",
    ]);
  });

  it("marks every tool read-only, non-destructive, idempotent and closed-world", async () => {
    for (const t of (await a.client.listTools()).tools) {
      expect(t.annotations, t.name).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it("advertises the strict input schemas, and an output schema, to clients", async () => {
    const byName = Object.fromEntries((await a.client.listTools()).tools.map((t) => [t.name, t]));
    const search = byName.search_policy!.inputSchema as JsonSchemaLike;
    expect(search.properties.top_k?.maximum).toBe(8);
    expect(search.properties.top_k?.minimum).toBe(1);
    expect(search.required).toEqual(["query"]);
    expect(search.additionalProperties).toBe(false);
    expect(
      (byName.get_order!.inputSchema as JsonSchemaLike).properties.order_id?.pattern,
    ).toBeDefined();
    expect(
      (byName.check_eligibility!.inputSchema as JsonSchemaLike).properties.request_type?.enum,
    ).toEqual(["return", "refund", "cancellation", "address_change"]);
    for (const t of Object.values(byName)) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.title, t.name).toBeTruthy();
      expect(t.description!.length, t.name).toBeGreaterThan(40);
    }
  });
});

describe("successful results match each tool's output schema", () => {
  const calls: [string, Record<string, unknown>][] = [
    ["search_policy", { query: "return pickup", top_k: 3 }],
    ["get_order", { order_id: "A-10413" }],
    ["get_customer", { customer_id: "cust_a_01" }],
    ["get_customer", { email: "ASHA.SHARMA1@example.com" }],
    ["check_eligibility", { order_id: "A-10413", request_type: "return" }],
  ];
  it.each(calls)("%s %j", async (name, args) => {
    const r = await a.call(name, args);
    expect(r.isError).toBe(false);
    const def = READ_TOOLS.find((t) => t.name === name)!;
    expect(def.output.safeParse(r.structuredContent).success).toBe(true);
    expect(r.structuredContent.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual(r.structuredContent); // text mirrors the structured result
  });
});

describe("shared error shape", () => {
  it("defines exactly the six codes, with only rate_limited and upstream_error retryable", () => {
    expect(ERROR_CODES).toEqual([
      "not_found",
      "invalid_input",
      "forbidden",
      "rate_limited",
      "upstream_error",
      "needs_approval",
    ]);
    const retryable = ERROR_CODES.filter((c) => toolError(c, "x").retryable);
    expect(retryable).toEqual(["rate_limited", "upstream_error"]);
  });

  const invalid: [string, Record<string, unknown>][] = [
    ["search_policy", {}],
    ["search_policy", { query: "refund", top_k: 9 }],
    ["search_policy", { query: "   " }],
    ["search_policy", { query: "refund", tenant_id: "tenant_b" }], // unknown fields are rejected
    ["get_order", {}],
    ["get_order", { order_id: "10413" }],
    ["get_order", { order_id: 10413 }],
    ["get_customer", {}],
    ["get_customer", { customer_id: "cust_a_01", email: "asha.sharma1@example.com" }],
    ["get_customer", { email: "not-an-email" }],
    ["check_eligibility", { order_id: "A-10413" }],
    ["check_eligibility", { order_id: "A-10413", request_type: "free_money" }],
  ];
  it.each(invalid)(
    "%s %j -> invalid_input in the shared shape, never free text",
    async (name, args) => {
      const r = await a.call(name, args);
      expect(r.isError).toBe(true);
      const err = ToolErrorSchema.parse(r.structuredContent);
      expect(err).toMatchObject({ ok: false, code: "invalid_input", retryable: false });
      expect(JSON.parse(r.text)).toEqual(err);
    },
  );

  it("not_found uses the shared shape", async () => {
    const r = await a.call("get_order", { order_id: "A-19999" });
    expect(ToolErrorSchema.parse(r.structuredContent)).toEqual({
      ok: false,
      code: "not_found",
      message: "No order with that ID for this tenant.",
      retryable: false,
    });
  });

  it("an internal failure becomes a retryable upstream_error and leaks no internals", async () => {
    const broken: TriageStore = {
      ...store,
      getOrder: async () => {
        throw new Error("SQLITE_CORRUPT: secret internal detail at /var/db/triage.db");
      },
    };
    const c = await connect(broken, "tenant_a");
    const original = console.error;
    console.error = () => {}; // the server logs the detail to stderr; keep test output clean
    try {
      const r = await c.call("get_order", { order_id: "A-10413" });
      const err = ToolErrorSchema.parse(r.structuredContent);
      expect(err).toMatchObject({ code: "upstream_error", retryable: true });
      expect(r.text).not.toMatch(/SQLITE|secret|\/var\/db/);
    } finally {
      console.error = original;
      await c.close();
    }
  });
});

describe("tenant scoping", () => {
  it("every order is visible to its own tenant and not_found to the other", async () => {
    for (const o of orders) {
      const own = o.tenant_id === "tenant_a" ? a : b;
      const other = o.tenant_id === "tenant_a" ? b : a;
      expect((await own.call("get_order", { order_id: o.id })).isError, o.id).toBe(false);
      const r = await other.call("get_order", { order_id: o.id });
      expect(r.structuredContent.code, o.id).toBe("not_found");
    }
  });

  it("another tenant's order is indistinguishable from one that does not exist", async () => {
    const otherTenants = await a.call("get_order", { order_id: "B-20410" });
    const missing = await a.call("get_order", { order_id: "A-19999" });
    expect(otherTenants).toEqual(missing);
    const elig1 = await a.call("check_eligibility", {
      order_id: "B-20410",
      request_type: "return",
    });
    const elig2 = await a.call("check_eligibility", {
      order_id: "A-19999",
      request_type: "return",
    });
    expect(elig1).toEqual(elig2);
  });

  it("another tenant's customer is not_found by ID and by email", async () => {
    const byId = await a.call("get_customer", { customer_id: "cust_b_10" });
    const byEmail = await a.call("get_customer", { email: "imran.iyer10@example.com" });
    const missing = await a.call("get_customer", { customer_id: "cust_a_99" });
    expect(byId).toEqual(missing);
    expect(byEmail).toEqual(missing);
  });

  it("no tool accepts a tenant argument, so a ticket cannot steer one", async () => {
    for (const t of (await a.client.listTools()).tools) {
      expect(Object.keys((t.inputSchema as JsonSchemaLike).properties), t.name).not.toContain(
        "tenant_id",
      );
    }
  });
});

describe("PII masking in get_customer", () => {
  it("never returns a full email or phone number for any of the 20 customers", async () => {
    for (const c of customers) {
      const client = c.tenant_id === "tenant_a" ? a : b;
      const r = await client.call("get_customer", { customer_id: c.id });
      const national = c.phone.replace(/\D/g, "").slice(-10);
      const local = c.email.split("@")[0]!;
      expect(r.text, c.id).not.toContain(c.email);
      expect(r.text, c.id).not.toContain(local);
      expect(r.text.replace(/\D/g, ""), c.id).not.toContain(national);
      const cust = r.structuredContent.customer as { phone_masked: string };
      expect(cust.phone_masked.endsWith(c.phone.slice(-4)), c.id).toBe(true);
    }
  });

  it("looking a customer up by their full email still returns it masked", async () => {
    const r = await a.call("get_customer", { email: "meera.patel5@example.com" });
    expect(r.text).not.toContain("meera.patel5");
    expect(r.structuredContent.customer).toMatchObject({ email_masked: "m***5@example.com" });
  });

  it("returns the customer's order count within the tenant", async () => {
    const r = await a.call("get_customer", { customer_id: "cust_a_01" });
    const n = (
      db.prepare("SELECT COUNT(*) c FROM orders WHERE customer_id='cust_a_01'").get() as {
        c: number;
      }
    ).c;
    expect((r.structuredContent.customer as { order_count: number }).order_count).toBe(n);
  });
});

describe("search_policy uses the configured retriever, within the bound tenant", () => {
  it("passes the server's tenant, never one from input, and returns the retriever's hits", async () => {
    const seen: string[] = [];
    const retriever: PolicyRetriever = {
      id: "fake",
      async search(tenantId, query, k) {
        seen.push(`${tenantId}|${query}|${k}`);
        return {
          hits: [
            { clauseId: "returns.window", title: "Return window", text: "7 days.", score: 0.9 },
          ],
          trace: {
            mode: "hybrid",
            keyword: [],
            vector: [],
            fused: [],
            reranked: [],
            ms: { keyword: 0, vector: 0, rerank: 0, total: 0 },
          },
        };
      },
    };
    const c = await connect(store, "tenant_b", { retriever });
    const r = await c.call("search_policy", { query: "return window", top_k: 2 });
    expect(seen).toEqual(["tenant_b|return window|2"]);
    expect(r.structuredContent).toEqual({
      ok: true,
      results: [
        { clause_id: "returns.window", title: "Return window", text: "7 days.", score: 0.9 },
      ],
    });
    await c.close();
  });
});

describe("search_policy", () => {
  it("finds the right clause for a plain question", async () => {
    const r = await a.call("search_policy", { query: "how do I start a return, is pickup free?" });
    const ids = (r.structuredContent.results as { clause_id: string }[]).map((x) => x.clause_id);
    expect(ids).toContain("returns.process");
  });

  it("respects top_k and defaults to 4", async () => {
    const two = await a.call("search_policy", { query: "refund return delivery", top_k: 2 });
    const dflt = await a.call("search_policy", { query: "refund return delivery" });
    expect((two.structuredContent.results as unknown[]).length).toBe(2);
    expect((dflt.structuredContent.results as unknown[]).length).toBe(4);
  });

  it("returns results ordered by score, best first", async () => {
    const r = await a.call("search_policy", { query: "damaged broken item photo", top_k: 8 });
    const scores = (r.structuredContent.results as { score: number }[]).map((x) => x.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it.each([
    'refund" OR 1=1 --',
    "NEAR(refund window)",
    "title:refund*",
    "refund AND NOT return",
    "रिफंड चाहिए refund",
  ])("treats FTS syntax in %j as plain words, never as query syntax", async (query) => {
    const r = await a.call("search_policy", { query });
    expect(r.isError).toBe(false);
  });

  it("a query with no searchable words returns no results, not an error", async () => {
    const r = await a.call("search_policy", { query: "?!?" });
    expect(r.structuredContent).toEqual({ ok: true, results: [] });
  });

  it("only ever returns real clause IDs", async () => {
    const real = new Set(loadPolicies().map((p) => p.clauseId));
    const r = await a.call("search_policy", {
      query: "refund return cancel address warranty delivery",
      top_k: 8,
    });
    for (const x of r.structuredContent.results as { clause_id: string }[])
      expect(real).toContain(x.clause_id);
  });
});

describe("check_eligibility answers the eval cases' questions correctly (today = 2026-11-20)", () => {
  it.each([
    ["A-10413", "return", true, "boundary-return-day-7-inside"],
    ["A-10414", "return", false, "boundary-return-day-8-outside"],
    ["A-10410", "return", true, "return-inside-window-sealed"],
    ["A-10412", "refund", true, "refund-inside-window-unwanted"],
    ["A-10419", "refund", false, "refund-outside-window-blender"],
    ["A-10416", "refund", false, "refund-pressure-social-media (day 13: return window passed)"],
    ["A-10403", "address_change", true, "address-change-before-dispatch"],
  ] as const)("%s %s -> eligible %s (%s)", async (...[order_id, request_type, eligible]) => {
    const r = await a.call("check_eligibility", { order_id, request_type });
    expect(r.structuredContent.eligible).toBe(eligible);
  });

  it.each([
    ["B-20402", "cancellation", true],
    ["B-20420", "refund", false],
    ["B-20409", "refund", true],
  ] as const)("tenant_b: %s %s -> eligible %s", async (order_id, request_type, eligible) => {
    const r = await b.call("check_eligibility", { order_id, request_type });
    expect(r.structuredContent.eligible).toBe(eligible);
  });

  it("flags a high-value refund (B-20409, 35297 INR) for manager approval", async () => {
    const r = await b.call("check_eligibility", { order_id: "B-20409", request_type: "refund" });
    expect(r.structuredContent.clause_ids).toContain("refunds.high_value");
  });

  it("never returns customer data", async () => {
    const r = await a.call("check_eligibility", {
      order_id: "A-10405",
      request_type: "cancellation",
    });
    expect(Object.keys(r.structuredContent).sort()).toEqual([
      "clause_ids",
      "eligible",
      "ok",
      "reason",
    ]);
    expect(r.text).not.toMatch(/Meera|Patel|@|\+91/);
  });

  it("uses the injected date, not the wall clock", async () => {
    const later = await connect(store, "tenant_a", { today: "2026-11-21" });
    const r = await later.call("check_eligibility", {
      order_id: "A-10413",
      request_type: "return",
    });
    expect(r.structuredContent.eligible).toBe(false); // day 8 when today is the 21st
    await later.close();
  });
});

describe("policy documents as MCP resources", () => {
  it("lists all 8 policy documents", async () => {
    const { resources } = await a.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(
      [
        "address",
        "cancellation",
        "contact",
        "damaged",
        "delivery",
        "refunds",
        "returns",
        "warranty",
      ].map((d) => `policy://${d}`),
    );
    for (const r of resources) expect(r.mimeType).toBe("text/markdown");
  });

  it("serves each document with all of its clauses", async () => {
    const chunks = loadPolicies();
    for (const { uri } of (await a.client.listResources()).resources) {
      const doc = uri.replace("policy://", "");
      const { contents } = await a.client.readResource({ uri });
      const text = (contents[0] as { text: string }).text;
      for (const c of chunks.filter((x) => x.doc === doc))
        expect(text, uri).toContain(`## ${c.clauseId}`);
    }
  });

  it("rejects an unknown document", async () => {
    await expect(a.client.readResource({ uri: "policy://secrets" })).rejects.toThrow();
  });
});

describe("server construction", () => {
  it("refuses an unknown tenant", async () => {
    await expect(connect(store, "tenant_zz")).rejects.toThrow(/Unknown tenant/);
  });
  it("refuses a malformed date", async () => {
    await expect(connect(store, "tenant_a", { today: "20/11/2026" })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

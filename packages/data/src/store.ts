import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Db } from "./sqlite/db.ts";
import { defaultPoliciesDir } from "./policies.ts";

/**
 * The storage interface every other package uses. It hides SQLite so a hosted adapter
 * (Supabase/Postgres with RLS) can implement the same contract.
 *
 * Tenant scoping is part of the contract: every tenant-owned read takes the tenant ID and
 * returns null for a record that belongs to another tenant, exactly as for one that does
 * not exist. Callers can never distinguish the two.
 *
 * Methods are async even though better-sqlite3 is synchronous, so a network-backed
 * adapter fits without changing callers.
 */
export interface TriageStore {
  tenantExists(tenantId: string): Promise<boolean>;
  getOrder(tenantId: string, orderId: string): Promise<OrderRecord | null>;
  getCustomerById(tenantId: string, customerId: string): Promise<CustomerRecord | null>;
  getCustomerByEmail(tenantId: string, email: string): Promise<CustomerRecord | null>;
  countOrders(tenantId: string, customerId: string): Promise<number>;
  /** Keyword (FTS5/BM25) search over policy clauses. Higher score = better match. */
  searchPoliciesKeyword(query: string, limit: number): Promise<PolicyHit[]>;
  listPolicyDocuments(): Promise<PolicyDocument[]>;
}

export type OrderStatus = "placed" | "dispatched" | "delivered" | "cancelled" | "returned";

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface OrderRecord {
  id: string;
  tenantId: string;
  customerId: string;
  status: OrderStatus;
  placedAt: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  returnedAt: string | null;
  total: number;
  currency: string;
  items: OrderItem[];
}

/** Raw customer record. Contains full PII; the tool layer masks it before anything leaves. */
export interface CustomerRecord {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  phone: string;
  tier: "standard" | "plus" | "vip";
}

export interface PolicyHit {
  clauseId: string;
  title: string;
  text: string;
  score: number;
}

export interface PolicyDocument {
  doc: string;
  title: string;
  clauseIds: string[];
  /** The policy file exactly as committed, frontmatter included. */
  markdown: string;
}

/**
 * Turn free text into a safe FTS5 query: words only, each quoted, OR-ed together.
 * Raw user text must never reach MATCH, because FTS5 syntax (quotes, AND/OR/NOT,
 * column filters, `*`) would either throw or change the query's meaning.
 */
export function toFtsQuery(text: string): string | null {
  // \p{M} keeps combining marks inside a word: Devanagari vowel signs (रिफंड) are marks, not separators.
  const words = text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const unique = [...new Set(words)].slice(0, 32);
  return unique.length ? unique.map((w) => `"${w}"`).join(" OR ") : null;
}

interface OrderRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  status: OrderStatus;
  placed_at: string;
  dispatched_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  returned_at: string | null;
  total: number;
  currency: string;
}

interface CustomerRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  phone: string;
  tier: CustomerRecord["tier"];
}

const toCustomer = (r: CustomerRow): CustomerRecord => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  tier: r.tier,
});

export function createSqliteStore(
  db: Db,
  options: { policiesDir?: string } = {},
): TriageStore {
  const policiesDir = options.policiesDir ?? defaultPoliciesDir();
  const q = {
    tenant: db.prepare("SELECT 1 FROM tenants WHERE id = ?"),
    order: db.prepare("SELECT * FROM orders WHERE tenant_id = ? AND id = ?"),
    items: db.prepare(
      "SELECT sku, name, qty, unit_price FROM order_items WHERE order_id = ? ORDER BY id",
    ),
    customerById: db.prepare("SELECT * FROM customers WHERE tenant_id = ? AND id = ?"),
    customerByEmail: db.prepare(
      "SELECT * FROM customers WHERE tenant_id = ? AND lower(email) = lower(?)",
    ),
    orderCount: db.prepare(
      "SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ? AND customer_id = ?",
    ),
    // bm25 weights per column: clause_id (unindexed) 0, title 2, text 1. Lower bm25 = better.
    fts: db.prepare(
      `SELECT c.clause_id, c.title, c.text, bm25(policy_fts, 0.0, 2.0, 1.0) AS rank
       FROM policy_fts JOIN policy_chunks c ON c.clause_id = policy_fts.clause_id
       WHERE policy_fts MATCH ? ORDER BY rank LIMIT ?`,
    ),
  };

  let documents: PolicyDocument[] | undefined;

  return {
    async tenantExists(tenantId) {
      return q.tenant.get(tenantId) !== undefined;
    },
    async getOrder(tenantId, orderId) {
      const r = q.order.get(tenantId, orderId) as OrderRow | undefined;
      if (!r) return null;
      const items = (
        q.items.all(r.id) as { sku: string; name: string; qty: number; unit_price: number }[]
      ).map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, unitPrice: i.unit_price }));
      return {
        id: r.id,
        tenantId: r.tenant_id,
        customerId: r.customer_id,
        status: r.status,
        placedAt: r.placed_at,
        dispatchedAt: r.dispatched_at,
        deliveredAt: r.delivered_at,
        cancelledAt: r.cancelled_at,
        returnedAt: r.returned_at,
        total: r.total,
        currency: r.currency,
        items,
      };
    },
    async getCustomerById(tenantId, customerId) {
      const r = q.customerById.get(tenantId, customerId) as CustomerRow | undefined;
      return r ? toCustomer(r) : null;
    },
    async getCustomerByEmail(tenantId, email) {
      const r = q.customerByEmail.get(tenantId, email) as CustomerRow | undefined;
      return r ? toCustomer(r) : null;
    },
    async countOrders(tenantId, customerId) {
      return (q.orderCount.get(tenantId, customerId) as { c: number }).c;
    },
    async searchPoliciesKeyword(query, limit) {
      const match = toFtsQuery(query);
      if (!match) return [];
      const rows = q.fts.all(match, limit) as {
        clause_id: string;
        title: string;
        text: string;
        rank: number;
      }[];
      return rows.map((r) => ({
        clauseId: r.clause_id,
        title: r.title,
        text: r.text,
        score: Math.round(-r.rank * 1000) / 1000,
      }));
    },
    async listPolicyDocuments() {
      documents ??= readdirSync(policiesDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => {
          const markdown = readFileSync(join(policiesDir, f), "utf8");
          const front = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
          if (!front) throw new Error(`${f}: missing frontmatter`);
          const meta = parse(front[1]!) as { doc: string; title: string; clauses: { id: string }[] };
          return {
            doc: meta.doc,
            title: meta.title,
            clauseIds: meta.clauses.map((c) => c.id),
            markdown,
          };
        });
      return documents;
    },
  };
}

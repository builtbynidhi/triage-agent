import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Db } from "./sqlite/db.ts";
import { defaultPoliciesDir } from "./policies.ts";
import { contentWords } from "./retrieval/text.ts";

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
  /** The merchant's display name, or null if the tenant does not exist. */
  getTenant(tenantId: string): Promise<{ id: string; name: string } | null>;
  getOrder(tenantId: string, orderId: string): Promise<OrderRecord | null>;
  getCustomerById(tenantId: string, customerId: string): Promise<CustomerRecord | null>;
  getCustomerByEmail(tenantId: string, email: string): Promise<CustomerRecord | null>;
  countOrders(tenantId: string, customerId: string): Promise<number>;
  /**
   * Keyword (FTS5/BM25) search over the policy clauses this tenant may see: shared clauses
   * plus its own. Higher score = better match.
   */
  searchPoliciesKeyword(tenantId: string, query: string, limit: number): Promise<PolicyHit[]>;
  /**
   * Nearest-neighbour search over the same clauses, by an already-embedded query.
   * Score = cosine similarity (vectors are unit length), higher = better.
   */
  searchPoliciesVector(
    tenantId: string,
    embedding: Float32Array,
    limit: number,
  ): Promise<PolicyHit[]>;
  /**
   * Bring the vector index in line with the policy chunks: embed only the chunks whose text,
   * position or embedding model changed, and drop vectors for chunks that no longer exist.
   */
  syncPolicyVectors(embedder: DocumentEmbedder): Promise<{ embedded: number; total: number }>;
  listPolicyDocuments(): Promise<PolicyDocument[]>;
}

/** The part of an embedder the store needs to build the vector index. */
export interface DocumentEmbedder {
  /** Identifies the model; changing it re-embeds everything. */
  readonly id: string;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
}

/** The text a clause is embedded as: its title carries much of its meaning. */
export const policyEmbeddingText = (title: string, text: string): string => `${title}. ${text}`;

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
 * Turn free text into a safe FTS5 query: content words only (stopwords dropped, see
 * retrieval/text.ts), each quoted, OR-ed together. Raw user text must never reach MATCH,
 * because FTS5 syntax (quotes, AND/OR/NOT, column filters, `*`) would either throw or
 * change the query's meaning.
 */
export function toFtsQuery(text: string): string | null {
  const unique = [...new Set(contentWords(text))].slice(0, 32);
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

export function createSqliteStore(db: Db, options: { policiesDir?: string } = {}): TriageStore {
  const policiesDir = options.policiesDir ?? defaultPoliciesDir();
  const q = {
    tenant: db.prepare("SELECT 1 FROM tenants WHERE id = ?"),
    tenantRow: db.prepare("SELECT id, name FROM tenants WHERE id = ?"),
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
       WHERE policy_fts MATCH ? AND (c.tenant_id IS NULL OR c.tenant_id = ?)
       ORDER BY rank LIMIT ?`,
    ),
    // sqlite-vec KNN is exact (brute force). k covers every vector so the tenant filter
    // after the join can never starve the result; fine for hundreds of clauses. At the
    // scale of many tenants with their own policies, use a vec0 partition key instead.
    vec: db.prepare(
      `SELECT c.clause_id, c.title, c.text, v.distance
       FROM (SELECT rowid, distance FROM policy_vec WHERE embedding MATCH ? AND k = ?) v
       JOIN policy_chunks c ON c.rowid = v.rowid
       WHERE c.tenant_id IS NULL OR c.tenant_id = ?
       ORDER BY v.distance LIMIT ?`,
    ),
    vecCount: db.prepare("SELECT COUNT(*) AS c FROM policy_vec_meta"),
    chunks: db.prepare("SELECT rowid, clause_id, title, text FROM policy_chunks ORDER BY rowid"),
    meta: db.prepare("SELECT clause_id, chunk_rowid, model, text_hash FROM policy_vec_meta"),
    vecDelete: db.prepare("DELETE FROM policy_vec WHERE rowid = ?"),
    vecInsert: db.prepare("INSERT INTO policy_vec (rowid, embedding) VALUES (?, ?)"),
    metaUpsert: db.prepare(
      `INSERT INTO policy_vec_meta (clause_id, chunk_rowid, model, text_hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(clause_id) DO UPDATE SET chunk_rowid = excluded.chunk_rowid,
         model = excluded.model, text_hash = excluded.text_hash`,
    ),
    metaDelete: db.prepare("DELETE FROM policy_vec_meta WHERE clause_id = ?"),
  };

  let documents: PolicyDocument[] | undefined;

  return {
    async getTenant(tenantId) {
      return (q.tenantRow.get(tenantId) as { id: string; name: string } | undefined) ?? null;
    },
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
    async searchPoliciesVector(tenantId, embedding, limit) {
      const all = (q.vecCount.get() as { c: number }).c;
      if (all === 0) return [];
      const rows = q.vec.all(
        Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        all,
        tenantId,
        limit,
      ) as {
        clause_id: string;
        title: string;
        text: string;
        distance: number;
      }[];
      // For unit vectors, squared L2 distance d^2 = 2 - 2cos, so cos = 1 - d^2 / 2.
      return rows.map((r) => ({
        clauseId: r.clause_id,
        title: r.title,
        text: r.text,
        score: Math.round((1 - (r.distance * r.distance) / 2) * 1000) / 1000,
      }));
    },
    async syncPolicyVectors(embedder) {
      const chunks = q.chunks.all() as {
        rowid: number;
        clause_id: string;
        title: string;
        text: string;
      }[];
      const meta = new Map(
        (
          q.meta.all() as {
            clause_id: string;
            chunk_rowid: number;
            model: string;
            text_hash: string;
          }[]
        ).map((m) => [m.clause_id, m]),
      );
      const withHash = chunks.map((c) => {
        const input = policyEmbeddingText(c.title, c.text);
        return { ...c, input, hash: createHash("sha256").update(input).digest("hex") };
      });
      const stale = withHash.filter((c) => {
        const m = meta.get(c.clause_id);
        return !m || m.chunk_rowid !== c.rowid || m.model !== embedder.id || m.text_hash !== c.hash;
      });
      const vectors = stale.length ? await embedder.embedDocuments(stale.map((c) => c.input)) : [];
      const live = new Set(chunks.map((c) => c.clause_id));
      db.transaction(() => {
        stale.forEach((c, i) => {
          const old = meta.get(c.clause_id);
          if (old) q.vecDelete.run(BigInt(old.chunk_rowid));
          q.vecDelete.run(BigInt(c.rowid));
          const v = vectors[i]!;
          q.vecInsert.run(BigInt(c.rowid), Buffer.from(v.buffer, v.byteOffset, v.byteLength));
          q.metaUpsert.run(c.clause_id, c.rowid, embedder.id, c.hash);
        });
        for (const [clauseId, m] of meta) {
          if (live.has(clauseId)) continue;
          q.vecDelete.run(BigInt(m.chunk_rowid));
          q.metaDelete.run(clauseId);
        }
      })();
      return { embedded: stale.length, total: chunks.length };
    },
    async searchPoliciesKeyword(tenantId, query, limit) {
      const match = toFtsQuery(query);
      if (!match) return [];
      const rows = q.fts.all(match, tenantId, limit) as {
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
          const meta = parse(front[1]!) as {
            doc: string;
            title: string;
            clauses: { id: string }[];
          };
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

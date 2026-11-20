import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDING_DIM,
  loadPolicies,
  migrate,
  migrations,
  openDb,
  parsePolicyFile,
} from "./index.ts";
import { SEED_TODAY, dateMinus, seed } from "./index.ts";

const dump = (db: ReturnType<typeof openDb>) => ({
  customers: db.prepare("SELECT * FROM customers ORDER BY id").all(),
  orders: db.prepare("SELECT * FROM orders ORDER BY id").all(),
  items: db
    .prepare("SELECT order_id, sku, name, qty, unit_price FROM order_items ORDER BY order_id, sku")
    .all(),
  chunks: db.prepare("SELECT * FROM policy_chunks ORDER BY clause_id").all(),
});

describe("migrations", () => {
  it("have unique, ascending ids", () => {
    const ids = migrations.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("are idempotent: re-running applies nothing and changes no schema", () => {
    const db = openDb(":memory:");
    const schema = () => db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    const before = schema();
    expect(migrate(db)).toBe(0);
    expect(migrate(db)).toBe(0);
    expect(schema()).toEqual(before);
    expect((db.prepare("SELECT COUNT(*) c FROM _migrations").get() as { c: number }).c).toBe(
      migrations.length,
    );
  });

  it("are idempotent across reopening a file database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "triage-")), "t.db");
    openDb(path).close();
    const db = openDb(path);
    expect(migrate(db)).toBe(0);
    db.close();
  });

  it("create FTS5 and a working sqlite-vec table", () => {
    const db = openDb(":memory:");
    const vec = new Float32Array(EMBEDDING_DIM).fill(0.1);
    db.prepare("INSERT INTO policy_vec (rowid, embedding) VALUES (?, ?)").run(
      1n,
      Buffer.from(vec.buffer),
    );
    const hit = db
      .prepare("SELECT rowid, distance FROM policy_vec WHERE embedding MATCH ? AND k = 1")
      .get(Buffer.from(vec.buffer)) as { rowid: number | bigint };
    expect(Number(hit.rowid)).toBe(1);
  });
});

describe("policies", () => {
  const chunks = loadPolicies();

  it("loads 8 documents with globally unique clause IDs", () => {
    expect(new Set(chunks.map((c) => c.doc)).size).toBe(8);
    const ids = chunks.map((c) => c.clauseId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of chunks) {
      expect(c.clauseId).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(c.clauseId.startsWith(`${c.doc}.`)).toBe(true);
      expect(c.text.length).toBeGreaterThan(40);
    }
  });

  it("rejects a clause with no body section and a section not in frontmatter", () => {
    const head = "---\ndoc: x\ntitle: X\nclauses:\n  - id: x.a\n    title: A\n---\n";
    expect(() => parsePolicyFile(head + "no sections here")).toThrow(/no section/);
    expect(() => parsePolicyFile(head + "## x.a\nok\n\n## x.b\nextra")).toThrow(
      /not in frontmatter/,
    );
  });

  it("are searchable through FTS5 after seeding", () => {
    const db = openDb(":memory:");
    seed(db);
    const rows = db
      .prepare("SELECT clause_id FROM policy_fts WHERE policy_fts MATCH ? ORDER BY rank")
      .all("pickup") as { clause_id: string }[];
    expect(rows.map((r) => r.clause_id)).toContain("returns.process");
  });
});

describe("seed", () => {
  it("is deterministic: two fresh databases are identical, and re-seeding changes nothing", () => {
    const a = openDb(":memory:");
    const b = openDb(":memory:");
    seed(a);
    seed(b);
    expect(dump(a)).toEqual(dump(b));
    const first = dump(a);
    seed(a);
    expect(dump(a)).toEqual(first);
  });

  it("has 2 tenants, 20 customers, 50 orders in every state", () => {
    const db = openDb(":memory:");
    seed(db);
    const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    expect(count("SELECT COUNT(*) c FROM tenants")).toBe(2);
    expect(count("SELECT COUNT(*) c FROM customers")).toBe(20);
    expect(count("SELECT COUNT(*) c FROM orders")).toBe(50);
    const statuses = (
      db.prepare("SELECT DISTINCT status FROM orders").all() as { status: string }[]
    ).map((r) => r.status);
    expect(statuses.sort()).toEqual(["cancelled", "delivered", "dispatched", "placed", "returned"]);
  });

  it("order totals equal the sum of their items, and customers belong to the order's tenant", () => {
    const db = openDb(":memory:");
    seed(db);
    const bad = db
      .prepare(
        `SELECT o.id FROM orders o
         LEFT JOIN (SELECT order_id, SUM(qty*unit_price) s FROM order_items GROUP BY order_id) i ON i.order_id=o.id
         JOIN customers c ON c.id=o.customer_id
         WHERE i.s IS NOT o.total OR c.tenant_id != o.tenant_id`,
      )
      .all();
    expect(bad).toEqual([]);
  });

  it("puts delivered orders on both sides of the 7-day return and 14-day refund windows", () => {
    const db = openDb(":memory:");
    seed(db);
    const ago = (
      db.prepare("SELECT delivered_at d FROM orders WHERE status='delivered'").all() as {
        d: string;
      }[]
    ).map((r) => Math.round((Date.parse(SEED_TODAY) - Date.parse(r.d)) / 86_400_000));
    for (const boundary of [6, 7, 8, 13, 14, 15]) expect(ago).toContain(boundary);
    expect(dateMinus(7)).toBe("2026-11-13");
  });

  it("keeps each tenant's orders distinct from the other's", () => {
    const db = openDb(":memory:");
    seed(db);
    const cross = db
      .prepare("SELECT COUNT(*) c FROM orders WHERE (id LIKE 'A-%') != (tenant_id = 'tenant_a')")
      .get() as { c: number };
    expect(cross.c).toBe(0);
  });
});

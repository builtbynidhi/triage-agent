import { dirname, resolve } from "node:path";
import { defaultDbPath, openDb, resetDb } from "./sqlite/db.ts";
import { seed } from "../seed/seed.ts";
import { createDefaultRetriever } from "./retrieval/defaults.ts";
import { createSqliteStore } from "./store.ts";

const cmd = process.argv[2];
const path = defaultDbPath();

if (cmd === "reset") {
  resetDb(path);
  openDb(path).close(); // recreate an empty, migrated database
  console.log(`db:reset  ${path} recreated with migrations applied`);
} else if (cmd === "seed") {
  const db = openDb(path);
  seed(db);
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  console.log(
    `db:seed   tenants=${n("tenants")} customers=${n("customers")} orders=${n("orders")} ` +
      `items=${n("order_items")} policy_chunks=${n("policy_chunks")}`,
  );
  db.close();
} else if (cmd === "index") {
  // Downloads the local models on first use (cached in .cache/models), builds the vector
  // index, and runs one search, so the first real search (e.g. in Claude Desktop) is instant.
  const db = openDb(path);
  const store = createSqliteStore(db);
  const t = performance.now();
  const { hits } = await createDefaultRetriever(store).search(
    "tenant_a",
    "how do I return an item?",
    4,
  );
  const vectors = (db.prepare("SELECT COUNT(*) c FROM policy_vec_meta").get() as { c: number }).c;
  console.log(
    `db:index  ${vectors} clause vectors ready, models loaded in ${Math.round(performance.now() - t)} ms; ` +
      `test search top hit: ${hits[0]?.clauseId ?? "none"}`,
  );
  db.close();
} else if (cmd === "demo") {
  // The live demo database (for Claude Desktop): seeded relative to the REAL today in India,
  // so the tools never contradict the client's own calendar. Tests and evals keep using the
  // fixed SEED_TODAY in data/triage.db. Re-run before a demo, since order ages drift daily.
  const demoPath = process.env.DEMO_DATABASE_PATH ?? resolve(dirname(path), "demo.db");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  resetDb(demoPath);
  const db = openDb(demoPath);
  seed(db, { today });
  await createDefaultRetriever(createSqliteStore(db)).search(
    "tenant_a",
    "how do I return an item?",
    4,
  );
  const order = (id: string) =>
    db.prepare("SELECT status, delivered_at FROM orders WHERE id = ?").get(id) as {
      status: string;
      delivered_at: string | null;
    };
  const a = order("A-10413");
  const b = order("B-20410");
  console.log(`db:demo   ${demoPath} seeded as of ${today} (today in India), vector index built`);
  console.log(`          try: A-10413 delivered ${a.delivered_at} (day 7: last day to return);`);
  console.log(
    `               A-10414 (delivered a day earlier) is day 8, outside; B-20410 (tenant_b) delivered ${b.delivered_at}`,
  );
  db.close();
} else {
  console.error("usage: node src/cli.ts <reset|seed|index|demo>");
  process.exit(1);
}

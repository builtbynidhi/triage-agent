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
} else {
  console.error("usage: node src/cli.ts <reset|seed|index>");
  process.exit(1);
}

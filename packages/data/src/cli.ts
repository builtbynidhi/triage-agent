import { defaultDbPath, openDb, resetDb } from "./sqlite/db.ts";
import { seed } from "../seed/seed.ts";

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
} else {
  console.error("usage: node src/cli.ts <reset|seed>");
  process.exit(1);
}

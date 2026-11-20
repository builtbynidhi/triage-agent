import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrations } from "./migrations.ts";

export type Db = Database.Database;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export function defaultDbPath(): string {
  return process.env.DATABASE_PATH
    ? resolve(process.env.DATABASE_PATH)
    : resolve(repoRoot, "data/triage.db");
}

/** Apply any migrations not yet recorded. Safe to call on every start. */
export function migrate(db: Db): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT id FROM _migrations").all() as { id: number }[]).map((r) => r.id),
  );
  let count = 0;
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        m.id,
        m.name,
        new Date().toISOString(),
      );
    })();
    count++;
  }
  return count;
}

/** Open a database ("":memory: allowed), load sqlite-vec, enable FKs and WAL, run migrations. */
export function openDb(path: string = defaultDbPath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

/** Delete the database file and its WAL/SHM sidecars. */
export function resetDb(path: string = defaultDbPath()): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

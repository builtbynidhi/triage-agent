/**
 * stdio entry point, for Claude Desktop, Claude Code or any MCP client that launches a process.
 *   TRIAGE_TENANT  required, e.g. tenant_a. One process serves one merchant.
 *   DATABASE_PATH  optional, defaults to data/triage.db at the repo root.
 *   TRIAGE_TODAY   optional YYYY-MM-DD, pins the clock (the seed is anchored to 2026-11-20).
 * stdout carries the protocol, so every log line goes to stderr.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createSqliteStore, defaultDbPath, openDb } from "@triage/data";
import { createTriageServer } from "./server.ts";

const tenantId = process.env.TRIAGE_TENANT;
if (!tenantId) {
  console.error("triage mcp-server: set TRIAGE_TENANT (e.g. tenant_a) to choose the merchant.");
  process.exit(1);
}

const db = openDb(defaultDbPath());
const store = createSqliteStore(db);
const options = { store, tenantId, today: process.env.TRIAGE_TODAY || undefined };

try {
  await createTriageServer(options); // fail fast on a bad tenant or date, before the client connects
} catch (err) {
  console.error(`triage mcp-server: ${(err as Error).message}`);
  process.exit(1);
}

serveStdio(() => createTriageServer(options));
console.error(`triage mcp-server: serving ${tenantId} over stdio`);

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createSqliteStore,
  openDb,
  seed,
  SEED_TODAY,
  type Db,
  type TriageStore,
} from "@triage/data";
import { createTriageServer, type TriageServerOptions } from "./server.ts";

export function seededStore(): { db: Db; store: TriageStore } {
  const db = openDb(":memory:");
  seed(db);
  return { db, store: createSqliteStore(db) };
}

export interface ConnectedClient {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  close(): Promise<void>;
}

export interface CallResult {
  isError: boolean;
  structuredContent: Record<string, unknown>;
  text: string;
}

/** A real MCP client talking to a real server over the SDK's in-memory transport. */
export async function connect(
  store: TriageStore,
  tenantId: string,
  extra: Partial<TriageServerOptions> = {},
): Promise<ConnectedClient> {
  const server = await createTriageServer({ store, tenantId, today: SEED_TODAY, ...extra });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return {
    client,
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const content = r.content as { type: string; text: string }[];
      return {
        isError: r.isError === true,
        structuredContent: r.structuredContent as Record<string, unknown>,
        text: content[0]?.text ?? "",
      };
    },
    close: () => client.close(),
  };
}

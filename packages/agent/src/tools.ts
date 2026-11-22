import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ToolSpec } from "@triage/providers";
import { createTriageServer, type TriageServerOptions } from "@triage/mcp-server";

/**
 * The agent's only way to reach the world: an MCP client. It never touches the database or calls
 * tool functions directly; it discovers tools and their schemas from the server and calls them
 * over the protocol, exactly as Claude Desktop does. Here the server runs in-process (in-memory
 * transport); the web app will use streamable HTTP.
 */
export interface ToolResult {
  /** Structured result: { ok: true, ... } or the shared error shape { ok: false, code, ... }. */
  structured: Record<string, unknown>;
  isError: boolean;
  /** Exactly what the model is shown as the tool message. */
  text: string;
}

export interface McpTools {
  merchant: string;
  /** The tools the model may call, in provider-neutral form (read-only tools only). */
  specs: ToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export async function connectTools(server: TriageServerOptions): Promise<McpTools> {
  const mcp = await createTriageServer(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "triage-agent", version: "0.1.0" });
  await client.connect(clientSide);

  const { tools } = await client.listTools();
  // Defence in depth: offer the model read-only tools only, whatever the server lists.
  const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);
  const store = await server.store.getTenant(server.tenantId);

  return {
    merchant: store?.name ?? server.tenantId,
    specs: readOnly.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema as Record<string, unknown>,
    })),
    async call(name, args) {
      if (!readOnly.some((t) => t.name === name)) {
        const structured = {
          ok: false,
          code: "forbidden",
          message: `No such tool: ${name}`,
          retryable: false,
        };
        return { structured, isError: true, text: JSON.stringify(structured) };
      }
      const r = await client.callTool({ name, arguments: args });
      const structured = (r.structuredContent ?? {}) as Record<string, unknown>;
      return { structured, isError: r.isError === true, text: JSON.stringify(structured) };
    },
    close: () => client.close(),
  };
}

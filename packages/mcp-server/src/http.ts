/**
 * Streamable HTTP transport, for the web app.
 *
 * Until Phase 10 adds JWT auth, the tenant comes from the `x-triage-tenant` header. Trusting a
 * header is only acceptable on loopback, so this refuses to bind anywhere else.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  createDefaultRetriever,
  createSqliteStore,
  defaultDbPath,
  openDb,
  type TriageStore,
} from "@triage/data";
import { createTriageServer, type TriageServerOptions } from "./server.ts";

export const TENANT_HEADER = "x-triage-tenant";
export const MCP_PATH = "/mcp";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface HttpServerOptions extends Omit<TriageServerOptions, "tenantId"> {
  store: TriageStore;
  host?: string;
  port?: number;
}

export interface RunningHttpServer {
  url: string;
  close(): Promise<void>;
}

const json = (res: import("node:http").ServerResponse, status: number, body: object) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `Refusing to bind ${host}: the HTTP transport is localhost-only until Phase 10 adds JWT auth.`,
    );
  }
  const serverOpts = {
    store: opts.store,
    today: opts.today,
    retriever: opts.retriever,
    searchPolicies: opts.searchPolicies,
  };

  const handler = createMcpHandler(async (ctx) => {
    // The tenant header was checked against the store before the request reached here.
    const tenantId = ctx.requestInfo?.headers.get(TENANT_HEADER) ?? "";
    return createTriageServer({ ...serverOpts, tenantId });
  });
  const mcp = toNodeHandler(handler);
  const hostOk = localhostHostValidation();
  const originOk = localhostOriginValidation();

  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") return json(res, 200, { ok: true });
    if (path !== MCP_PATH) return json(res, 404, { error: "not found" });
    if (!hostOk(req, res) || !originOk(req, res)) return; // guards already wrote a 403
    const tenant = req.headers[TENANT_HEADER];
    if (typeof tenant !== "string" || !(await opts.store.tenantExists(tenant))) {
      return json(res, 401, { error: `missing or unknown ${TENANT_HEADER} header` });
    }
    await mcp(req, res);
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 3100, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${port}${MCP_PATH}`,
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = createSqliteStore(openDb(defaultDbPath()));
  const running = await startHttpServer({
    store,
    retriever:
      process.env.TRIAGE_RETRIEVAL === "keyword" ? undefined : createDefaultRetriever(store),
    port: Number(process.env.PORT ?? 3100),
    today: process.env.TRIAGE_TODAY || undefined,
  });
  console.error(`triage mcp-server: streamable HTTP on ${running.url} (send ${TENANT_HEADER})`);
}

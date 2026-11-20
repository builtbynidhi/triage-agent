import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createSqliteStore, openDb, seed, SEED_TODAY } from "@triage/data";
import { startHttpServer, TENANT_HEADER, type RunningHttpServer } from "./http.ts";

const STDIO_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "stdio.ts");
const run = promisify(execFile);

/** A seeded database file on disk, as a real deployment (or Claude Desktop) would use. */
const dbPath = join(mkdtempSync(join(tmpdir(), "triage-mcp-")), "triage.db");
const db = openDb(dbPath);
seed(db);
const store = createSqliteStore(db);

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
);

const firstText = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

describe("stdio transport (how Claude Desktop runs the server)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [STDIO_ENTRY],
        env: {
          ...baseEnv,
          DATABASE_PATH: dbPath,
          TRIAGE_TENANT: "tenant_b",
          TRIAGE_TODAY: SEED_TODAY,
        },
        stderr: "ignore",
      }),
    );
  }, 20_000);
  afterAll(() => client?.close());

  it("lists the four tools and eight policy resources", async () => {
    expect((await client.listTools()).tools).toHaveLength(4);
    expect((await client.listResources()).resources).toHaveLength(8);
  });

  it("calls every tool end to end", async () => {
    const results = await Promise.all([
      client.callTool({ name: "search_policy", arguments: { query: "warranty on headphones" } }),
      client.callTool({ name: "get_order", arguments: { order_id: "B-20410" } }),
      client.callTool({ name: "get_customer", arguments: { customer_id: "cust_b_10" } }),
      client.callTool({
        name: "check_eligibility",
        arguments: { order_id: "B-20410", request_type: "return" },
      }),
    ]);
    for (const r of results) expect(r.isError, firstText(r)).toBe(false);
    expect(results[3]!.structuredContent).toMatchObject({ eligible: true });
  });

  it("is bound to the tenant from its environment", async () => {
    const r = await client.callTool({ name: "get_order", arguments: { order_id: "A-10413" } });
    expect(r.structuredContent).toMatchObject({ code: "not_found" });
  });

  it("reads a policy resource", async () => {
    const { contents } = await client.readResource({ uri: "policy://warranty" });
    expect((contents[0] as { text: string }).text).toContain("warranty.period");
  });
});

describe("stdio entry point fails fast and clearly", () => {
  const start = (env: Record<string, string>) =>
    run(process.execPath, [STDIO_ENTRY], {
      env: { ...baseEnv, DATABASE_PATH: dbPath, ...env },
      timeout: 10_000,
    });

  it("without TRIAGE_TENANT", async () => {
    const env = { ...baseEnv };
    delete env.TRIAGE_TENANT;
    await expect(
      run(process.execPath, [STDIO_ENTRY], {
        env: { ...env, DATABASE_PATH: dbPath },
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("set TRIAGE_TENANT") });
  });

  it("with an unknown tenant", async () => {
    await expect(start({ TRIAGE_TENANT: "tenant_zz" })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unknown tenant"),
    });
  });

  it("with a malformed TRIAGE_TODAY", async () => {
    await expect(
      start({ TRIAGE_TENANT: "tenant_a", TRIAGE_TODAY: "tomorrow" }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("YYYY-MM-DD"),
    });
  });
});

describe("streamable HTTP transport (for the web app)", () => {
  let server: RunningHttpServer;
  const clientFor = async (tenant: string) => {
    const c = new Client({ name: "http-test", version: "0.0.0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { [TENANT_HEADER]: tenant } },
      }),
    );
    return c;
  };

  beforeAll(async () => {
    server = await startHttpServer({ store, port: 0, today: SEED_TODAY });
  });
  afterAll(() => server?.close());

  it("serves the same tools, bound to the tenant in the header", async () => {
    const b = await clientFor("tenant_b");
    const a = await clientFor("tenant_a");
    try {
      expect((await b.listTools()).tools).toHaveLength(4);
      const own = await b.callTool({ name: "get_order", arguments: { order_id: "B-20410" } });
      const other = await a.callTool({ name: "get_order", arguments: { order_id: "B-20410" } });
      expect(own.isError).toBe(false);
      expect(other.structuredContent).toMatchObject({ code: "not_found" });
      const elig = await a.callTool({
        name: "check_eligibility",
        arguments: { order_id: "A-10413", request_type: "return" },
      });
      expect(elig.structuredContent).toMatchObject({ eligible: true });
    } finally {
      await a.close();
      await b.close();
    }
  });

  const post = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const url = new URL(server.url);
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });

  it("rejects a request with no tenant header (401)", async () => {
    expect(await post({})).toBe(401);
  });

  it("rejects an unknown tenant (401)", async () => {
    expect(await post({ [TENANT_HEADER]: "tenant_zz" })).toBe(401);
  });

  it("rejects a foreign Host header, against DNS rebinding (403)", async () => {
    expect(await post({ [TENANT_HEADER]: "tenant_a", host: "evil.example.com" })).toBe(403);
  });

  it("rejects a foreign browser Origin (403)", async () => {
    expect(await post({ [TENANT_HEADER]: "tenant_a", origin: "https://evil.example.com" })).toBe(
      403,
    );
  });

  it("refuses to bind to a non-loopback address before auth exists", async () => {
    await expect(startHttpServer({ store, host: "0.0.0.0", port: 0 })).rejects.toThrow(
      /localhost-only/,
    );
  });
});

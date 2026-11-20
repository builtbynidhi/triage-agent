# 0002. The agent's tools live behind an MCP server

- Status: accepted
- Date: 2026-11-20
- Phase: 3

## Context

The agent needs four read tools now (policy search, order lookup, customer lookup, eligibility) and two approval-gated write tools later. The tools could be plain functions the agent loop imports, or a separate server speaking the Model Context Protocol.

## Decision

The tools are an MCP server (`packages/mcp-server`). The agent reaches data only through it, never the database directly. One tool registry feeds two transports: stdio, for Claude Desktop or Claude Code, and streamable HTTP, for the web app.

We use **v2 of the official TypeScript SDK** (`@modelcontextprotocol/server` 2.4, `@modelcontextprotocol/node` 2.1, `@modelcontextprotocol/client` 2.4 for tests). The build spec names `@modelcontextprotocol/sdk`, which is the v1 package. v2 is the current stable line and officially replaces it, and the spec itself said to follow the installed version's docs rather than memory. The v2 API differs from v1: `serveStdio()` replaces `StdioServerTransport` plus `connect()`, and `createMcpHandler()` replaces the per-request HTTP transport.

## Consequences

- **The tools are a contract.** Each has a declared input and output schema and behaviour annotations, visible to any client. A reviewer can read what the agent is able to do without reading the agent.
- **The agent cannot reach the database.** That narrows what a prompt injection can achieve to what these tools allow.
- **The same tools are demoable live** in Claude Desktop or Claude Code, independently of our agent loop.
- **The tenant is bound by the transport, never passed as a tool argument**: an environment variable for stdio, a header for HTTP until Phase 10 replaces it with a JWT claim. No ticket text can steer a tool to another merchant.
- Cost: one more process and protocol hop per tool call. Tool calls are milliseconds; model calls are seconds, so this does not matter.
- **One SDK behaviour we work around.** When input fails a tool's schema, SDK 2.4 replies with a free-text error. Our agent branches on error codes, so each tool advertises its strict schema to clients but validates input itself and returns `invalid_input` in the shared error shape (`advertiseOnly` in `src/registry.ts`). A test proves that removing the wrapper breaks 12 error-shape tests.

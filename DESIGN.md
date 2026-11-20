# DESIGN

Outline only. Bodies are filled in during the phase that makes each decision.

## 1. High-level design (HLD)

- Three layers and the cross-cutting band (tracing, cost ledger, guardrails)
- Request path: API → queue → worker → agent → MCP tools → data
- Why each boundary exists (queue, MCP server, provider router, validator, approval queue, eval harness)

## 2. Component low-level design (LLD)

- packages/agent: state machine, budget, prompts, validator, repair
- packages/providers: router, adapters, cache, replay, cost ledger
- packages/mcp-server: six tools, shared error shape, annotations, transports, resources
- packages/data: schema, FTS5, sqlite-vec, queue (leases, retries, dead letters), seed
- apps/api, apps/web, evals

## 3. Trade-offs

- Hand-written state machine vs a framework (and the LangGraph port)
- Eligibility as code, not a model call
- PII masked at the tool boundary
- SQLite queue vs Redis; two stores, no third (no MongoDB)
- Consistency, caching, rate limiting
- OpenTelemetry GenAI conventions are Development status; pinned version noted here

## 4. Open questions

- (to be filled as they arise)

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

### 2.1 packages/data (Phase 1)

**One file, two indexes.** Relational data, the FTS5 keyword index and the sqlite-vec vector index all live in one SQLite file. A single connection loads sqlite-vec, turns on foreign keys and WAL, and runs migrations on open.

**Schema.** Tenancy is a column (`tenant_id`) on every table a tool reads, and the indexes lead with it (`orders(tenant_id, customer_id)`, `orders(tenant_id, status)`, `runs(tenant_id, created_at DESC)`). Every tool query is tenant-scoped, so the index matches the access pattern. A partial unique index `runs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL` makes a retried `POST /triage` collide instead of creating a second run. Status and decision columns are `CHECK`-constrained, so a bad value fails at the database, not later. Money is stored as integer rupees, never floats.

**Migrations** are an ordered, append-only list recorded in `_migrations`, each applied in its own transaction. An applied migration is never edited; a change is a new migration. This is what makes "runs on every start" safe.

**Policy chunks.** One chunk per clause, keyed by its stable `clause_id`. The clause is the unit the agent must cite, so it is also the unit of retrieval. FTS5 uses the `porter unicode61` tokenizer, so "returned" matches "return". The FTS table is standalone rather than external-content: the index is tiny and rebuilt whole on seed, so the extra sync triggers buy nothing. `policy_vec` rows share `rowid` with `policy_chunks`.

**Deterministic seed.** All dates derive from a fixed `SEED_TODAY` (2026-11-20), not the wall clock, so window arithmetic and eval fixtures give the same answer on every machine and every day. Delivered orders sit at 6/7/8 and 13/14/15 days ago, so the 7-day return and 14-day refund boundaries are both exercised, with the delivery day counted as day 0. Seeding wipes every table, runs included, because a partial reseed could leave runs pointing at orders that no longer exist.

### 2.2 packages/mcp-server (Phase 3)

**Shape.** One tool registry (`src/tools/`, one file per tool, schemas beside the handler) feeds both transports. `createTriageServer({ store, tenantId, today, searchPolicies })` builds one MCP server bound to one tenant. `stdio.ts` calls it once per connection via `serveStdio`. `http.ts` calls it per request via `createMcpHandler`. Built on MCP TypeScript SDK v2 (ADR 0002).

**What a tool may touch.** A `ToolContext` with the `TriageStore` interface (never the database), the bound tenant ID, an injected `today()`, and a `searchPolicies()` function. Tenant and date are fixed when the server is built, never taken from tool input, so a ticket cannot steer them. A test asserts that no tool schema has a tenant field, and that unknown fields are rejected.

**One call, one path.** `invokeTool()` validates input with the tool's Zod schema, runs the handler, validates the tool's _own_ output (a malformed success is a bug, never sent), and maps every failure to the shared error shape. Expected failures (`not_found`) are returned. An unexpected exception becomes `upstream_error` (retryable), with the detail logged to stderr and never put in the result. MCP calls and unit tests go through the same function.

**Why the strict schema is advertised but not enforced by the SDK.** SDK 2.4 answers a schema violation with a free-text `isError` result. The agent must branch on `code`, so `advertiseOnly()` hands the SDK a wrapper that exposes the strict schema's JSON Schema (via `~standard.jsonSchema`) and accepts any value. `invokeTool` then validates and returns `invalid_input`. Clients still see the full schema (`top_k` maximum 8, `additionalProperties: false`, enums, patterns), and tests check that.

**Results.** Success: `{ ok: true, ... }` as `structuredContent`, with the same JSON as a text block for clients that only read text. Failure: `{ ok: false, code, message, retryable }` with `isError: true`. The SDK and the client both skip output-schema validation on `isError` results (confirmed in the installed SDK source), so failures can carry the structured error.

**Tenant scoping, twice.** Every store query takes the tenant ID and filters on it in SQL. The tools then return one message for "missing" and "another tenant's", so the two are byte-for-byte identical (tested for every one of the 50 orders, and for customers by ID and by email).

**search_policy, for now.** FTS5 with BM25 (title weighted 2x over text), behind `ctx.searchPolicies` so Phase 4 can swap in hybrid retrieval, and Phase 7 can wrap it to plant the poisoned-policy fixture. User text never reaches `MATCH` raw: `toFtsQuery` keeps only words (letters, combining marks and digits, so Devanagari survives), quotes each one, and ORs them. FTS operators in a ticket become plain words.

**HTTP transport security until Phase 10.** The tenant comes from an `x-triage-tenant` header, which is only acceptable on loopback. `startHttpServer` therefore refuses to bind to a non-loopback address, rejects requests whose Host or browser Origin is not localhost (DNS-rebinding protection from `@modelcontextprotocol/node`), and returns 401 for a missing or unknown tenant. Phase 10 replaces the header with a verified JWT claim.

**Resources.** Each policy file is an MCP resource, `policy://{doc}`, served as committed (frontmatter included), so a person in a client can read exactly what the agent cites.

### 2.3 Policy retrieval (Phase 4)

**Pipeline.** `createPolicyRetriever` in `packages/data/src/retrieval/`. FTS5 keyword search (BM25, title weighted 2x, stopwords removed) and sqlite-vec vector search (exact KNN over unit vectors, scored as cosine) each return their top 10. They are merged by reciprocal rank fusion (k = 60), and the fused top 10 go to a swappable `Reranker`, which returns the top k. Every search returns a `RetrievalTrace` with each stage's ranking and timings, for the Phase 11 trace viewer.

**Production configuration** (ADR 0005): `bge-small-en-v1.5` embeddings and the `ms-marco-MiniLM-L-6-v2` cross-encoder, both q8, run locally on the CPU through `@huggingface/transformers`. They load lazily, once per process, from `.cache/models`. `MODELS_OFFLINE=1` forbids downloads. `pnpm db:index` pre-downloads and builds the index.

**Why RRF.** BM25 scores and cosine similarities live on unrelated scales. RRF uses only ranks, so it needs no calibration between them. Its known weakness is measured in `docs/retrieval.md`: with equal weight, a noisy keyword list can pull down a strong vector list. That is why the reranker, not the fusion order, has the last word.

**A self-maintaining vector index.** `policy_vec_meta` records, for each clause, the rowid, embedding model and text hash its vector was built from. `syncPolicyVectors` re-embeds only what changed (edited text, a moved row, a new model) and drops vectors of deleted clauses. The retriever calls it lazily before its first vector search, so a policy edit, a reseed or a model swap can never leave stale vectors behind.

**Tenant-scoped retrieval** (OWASP LLM09). `policy_chunks.tenant_id` is NULL for a policy every tenant shares, or a tenant ID for a policy only that tenant's searches may return. Both keyword and vector search filter on it, and tests prove a tenant-specific clause is invisible to the other tenant. Today all 8 policies are shared. The vector KNN covers every vector before the tenant filter, which is exact and cheap at hundreds of clauses; at the scale of many tenants with their own policies, a vec0 partition key would replace it.

**Measured, not assumed.** `pnpm eval:retrieval` measures 13 configurations on 27 eval-derived and 32 held-out questions, and writes `docs/retrieval.md`. `evals/src/retrieval.test.ts` is a regression gate on the production configuration with the real models. Headline: hybrid with cross-encoder is best on short questions (96.9% hit@4), while vector-only is best on raw tickets (70.4%). That is why the `search_policy` description asks the agent for one short question per call.

## 3. Trade-offs

- Hand-written state machine vs a framework (and the LangGraph port)
- Eligibility as code, not a model call: ADR 0004
- PII masked at the tool boundary: ADR 0003
- Tools behind an MCP server: ADR 0002
- Retrieval configuration (hybrid with cross-encoder, chosen from measurements): ADR 0005
- SQLite queue vs Redis; two stores, no third (no MongoDB)

### 3.1 SQLite jobs table instead of Redis (Phase 1)

**Decision:** the queue is a `jobs` table in the same SQLite file: `status`, `attempts`/`max_attempts`, `run_after` for backoff, `lease_until` for a crashed worker's job to become claimable again, and a `dead` state for dead letters.

**Why:** zero running cost (no Redis host), one fewer moving part, and the job is written in the same transaction as its `runs` row. That gives an atomic "run exists ⇔ job exists", which Redis plus a database cannot give without an outbox.

**Cost:** SQLite allows one writer at a time, so this fits one worker process or a few, not a fleet. Throughput here is bounded by model latency (seconds per ticket), not queue writes, so that limit is far away. Moving to Postgres (`SELECT … FOR UPDATE SKIP LOCKED`) or a real broker is a change inside `packages/data`, behind the same interface.

### 3.2 No build step: Node runs TypeScript directly (Phase 1)

**Decision:** scripts and tests run `.ts` files through Node's built-in type stripping. There is no `tsc` emit and no `tsx`. `tsc` is used only to typecheck.

**Why:** one fewer dependency, and no `dist/` that can drift out of sync with the source. What you read is what runs.

**Cost:** only erasable TypeScript is allowed (no `enum`, no constructor parameter properties, no `namespace`), and relative imports must end in `.ts`. `erasableSyntaxOnly` and `allowImportingTsExtensions` in `tsconfig.base.json` enforce this at typecheck time. The Next.js app has its own compiler and is unaffected.

### 3.3 Secret scan as a versioned hook

`scripts/check-secrets.sh` runs from `.githooks/pre-commit`. `pnpm install` points `core.hooksPath` at `.githooks` through the `prepare` script, so every clone gets the hook without a hook-manager dependency. The `prepare` script no-ops outside a git checkout (for example inside a Docker build). CI will run the same script, so the check does not depend on a contributor's local setup.

- Consistency, caching, rate limiting
- OpenTelemetry GenAI conventions are Development status; pinned version noted here

## 4. Open questions

- **Resolved: a thank-you needs no action.** It is AUTO_REPLY with intent `acknowledgement`, the one intent exempt from the clause-citation rule (see CLAUDE.md, "Decisions on the decision contract").
- **Resolved: address changes and cancellations escalate,** because no tool performs them (see CLAUDE.md, "Decisions on the decision contract").
- **Repeats in replay mode.** Cassettes are keyed by request hash, so 3 repeats replay the same response. Decide in Phase 5 whether the repeat index belongs in the key.
- **Eligibility clause IDs and the citation rule (Phase 6).** The validator fails any cited clause not returned by `search_policy` this run. `check_eligibility` also returns authoritative clause IDs the reply must cite, so the validator should accept those too. Otherwise a correct reply could fail validation.
- **Resolved: tenant-scoped retrieval.** `policy_chunks.tenant_id` (NULL = shared), filtered in keyword and vector search (§2.3).
- **"Remote" delivery locations are undefined** in `delivery.estimates`, so the Guwahati case accepts either band. A policy edit could pin it down.
- **Check retrieval with the agent's real queries (Phase 7).** ADR 0005 chose hybrid with cross-encoder on the assumption that the agent sends short, focused questions. If its queries look like raw tickets, vector-only is the measured fallback.

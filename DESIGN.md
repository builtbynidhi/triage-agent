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

## 3. Trade-offs

- Hand-written state machine vs a framework (and the LangGraph port)
- Eligibility as code, not a model call
- PII masked at the tool boundary
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

- **A thank-you needs no action, but the four-decision contract has no "no action" outcome.** The case `thank-you-no-action` expects REJECT, the only decision that drafts no reply; AUTO_REPLY would need a policy citation a thank-you does not have. Alternative: a fifth decision, which changes the contract.
- **Address changes and cancellations are allowed by policy, but no tool performs them.** The cases expect ESCALATE, so a human makes the change. Alternative: AUTO_REPLY saying the change is allowed, which would promise an action nothing performs. Revisit if an `update_order` write tool is added.
- **Repeats in replay mode.** Cassettes are keyed by request hash, so 3 repeats replay the same response. Decide in Phase 5 whether the repeat index belongs in the key.

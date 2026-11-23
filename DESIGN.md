# DESIGN

The design of triage-agent: how it fits together, why each boundary exists, the trade-offs, and what is still open. Written phase by phase; brought up to date at the end of Phase 12.

## 1. High-level design (HLD)

Everything in this section is **built** and tested unless it says otherwise.

### 1.1 Shape

Three thin layers and one cross-cutting band.

```
              ┌──────────────────────────── cross-cutting band ─────────────────────────────┐
              │  tracing (OTel GenAI spans) · cost and token ledger · budgets · guardrails  │
              └─────────────────────────────────────────────────────────────────────────────┘
 ticket ─► [ API ] ─► [ jobs queue ] ─► [ worker: agent state machine ] ─► [ MCP server ] ─► [ data ]
           Express     table in the     classify, retrieve, gather,         six tools: 4      SQLite,
           JWT, rate   same SQLite      decide, validate, one repair,       read, 2 write     FTS5,
           limit, key  file: lease,     propose                             (approval-gated)  sqlite-vec
                       retry, dead                  │
                       letter                       ▼
                                             [ provider router ] ─► Groq / Gemini / replay
 reviewer ─► [ approval queue ] ─► the only path to a write tool (the tool re-checks the approval)
 eval harness ─► drives the same entry point a real ticket uses; CI replays it and gates on a baseline
 trace viewer (Next.js) ─► reads the API, or a read-only snapshot (the public demo)
```

### 1.2 One ticket, end to end

1. `POST /v1/triage` authenticates (JWT, merchant from the token only), rate-limits per merchant, checks an idempotency key, writes a `tickets`, a `runs` and a `jobs` row in one transaction, and returns 202 with a run ID (§2.7).
2. A worker leases the job and runs the agent state machine with a budget of 8 steps, 6 tool calls and 24k tokens (§2.5).
3. The agent reaches the world **only** through the MCP server: `search_policy` (hybrid retrieval), `get_order`, `get_customer` (PII masked) and `check_eligibility` (rules in code) (§2.2, §2.3).
4. The model's decision is validated against the schema and the rules, with one repair attempt, then the run fails closed to ESCALATE. Input is quarantined first and obvious override attempts never reach the model (§2.5, SECURITY.md).
5. The proposal waits in the approval queue. A reviewer approves exactly what is shown; the write tool then re-checks the approval and records the write once (§2.7).
6. Every step emits an OpenTelemetry span with token counts; the spans are saved with the run and drawn by the trace viewer (§2.8, §2.9).

### 1.3 Why each boundary exists

| Boundary                                 | Why                                                                                                                                                                                                                                  | Status                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Queue between API and agent              | A triage run takes seconds, and an HTTP request should not wait on a model. The queue also gives retries and dead letters, and the job is written atomically with its run (§3.1).                                                    | Schema built; worker planned |
| MCP server between agent and data        | The tools become a contract with declared schemas, usable from Claude Desktop as well as our own loop, and the agent cannot reach the database directly (ADR 0002). Tenant and date are bound by the transport, never by tool input. | Built                        |
| Code, not the model, for eligibility     | Money decisions are date arithmetic: deterministic, tested at every boundary, auditable (ADR 0004).                                                                                                                                  | Built                        |
| PII masked at the tool boundary          | A value the model never sees cannot leak through any prompt or injection (ADR 0003).                                                                                                                                                 | Built                        |
| Hybrid retrieval with reranking          | Measured, not assumed: best on focused questions, so the agent is told to ask them (ADR 0005, docs/retrieval.md).                                                                                                                    | Built                        |
| Provider router between agent and models | One interface, three implementations: primary, fallback, and replay of recorded responses, so CI is free and deterministic.                                                                                                          | Planned, Phase 5             |
| Validator between model and system       | A model returns text, and the system needs a typed decision. Validate, allow one repair, then fail closed.                                                                                                                           | Planned, Phase 6             |
| Approval queue before any write          | The agent proposes, a human commits: the mitigation for excessive agency.                                                                                                                                                            | Planned, Phase 10            |
| Eval harness outside the agent           | It drives the same entry point a real ticket uses, so the system is graded, not a special test path.                                                                                                                                 | Built (Phases 2 and 7)       |

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

**HTTP transport security.** The tenant comes from an `x-triage-tenant` header, which is only acceptable on loopback. `startHttpServer` therefore refuses to bind to a non-loopback address, rejects requests whose Host or browser Origin is not localhost (DNS-rebinding protection from `@modelcontextprotocol/node`), and returns 401 for a missing or unknown tenant. The Express API from Phase 10 does not use this header: it takes the merchant from a verified JWT claim (§2.7). This MCP HTTP transport still uses the header, so it stays loopback-only, for local MCP clients.

**Resources.** Each policy file is an MCP resource, `policy://{doc}`, served as committed (frontmatter included), so a person in a client can read exactly what the agent cites.

### 2.3 Policy retrieval (Phase 4)

**Pipeline.** `createPolicyRetriever` in `packages/data/src/retrieval/`. FTS5 keyword search (BM25, title weighted 2x, stopwords removed) and sqlite-vec vector search (exact KNN over unit vectors, scored as cosine) each return their top 10. They are merged by reciprocal rank fusion (k = 60), and the fused top 10 go to a swappable `Reranker`, which returns the top k. Every search returns a `RetrievalTrace` with each stage's ranking and timings, for the Phase 11 trace viewer.

**Production configuration** (ADR 0005): `bge-small-en-v1.5` embeddings and the `ms-marco-MiniLM-L-6-v2` cross-encoder, both **fp32**, run locally on the CPU through `@huggingface/transformers`. fp32 rather than q8 because int8 kernels differ between ARM and x86, so q8 rankings differed between macOS and the Linux CI runner and recordings would not replay across machines. They load lazily, once per process, from `.cache/models`. `MODELS_OFFLINE=1` forbids downloads. `pnpm db:index` pre-downloads and builds the index.

**Why RRF.** BM25 scores and cosine similarities live on unrelated scales. RRF uses only ranks, so it needs no calibration between them. Its known weakness is measured in `docs/retrieval.md`: with equal weight, a noisy keyword list can pull down a strong vector list. That is why the reranker, not the fusion order, has the last word.

**A self-maintaining vector index.** `policy_vec_meta` records, for each clause, the rowid, embedding model and text hash its vector was built from. `syncPolicyVectors` re-embeds only what changed (edited text, a moved row, a new model) and drops vectors of deleted clauses. The retriever calls it lazily before its first vector search, so a policy edit, a reseed or a model swap can never leave stale vectors behind.

**Tenant-scoped retrieval** (OWASP LLM09). `policy_chunks.tenant_id` is NULL for a policy every tenant shares, or a tenant ID for a policy only that tenant's searches may return. Both keyword and vector search filter on it, and tests prove a tenant-specific clause is invisible to the other tenant. Today all 8 policies are shared. The vector KNN covers every vector before the tenant filter, which is exact and cheap at hundreds of clauses; at the scale of many tenants with their own policies, a vec0 partition key would replace it.

**Measured, not assumed.** `pnpm eval:retrieval` measures 13 int8 configurations plus the fp32 production configuration on 27 eval-derived and 32 held-out questions, and writes `docs/retrieval.md`. `evals/src/retrieval.test.ts` is a regression gate on the production configuration with the real models. Headline: hybrid with cross-encoder is best on short questions (96.9% hit@4), while vector-only is best on raw tickets (70.4%). That is why the `search_policy` description asks the agent for one short question per call.

### 2.4 Provider router (Phase 5)

**One interface, two vendors.** `ChatRequest` / `ChatResponse` in `packages/providers` are provider-neutral. Adapters translate to raw REST: Gemini `generateContent` and Groq's OpenAI-compatible chat completions, with no SDK and no new dependency. Field names were checked against the vendors' docs **and** a live call, because the docs contradicted themselves (for example `responseJsonSchema` vs `responseFormat.text.schema`).

**Route** (decided 2026-11-22, revised the same day): primary Groq `openai/gpt-oss-120b` (reasoning low), fallback `gemini-3.6-flash` (thinking LOW). Versions are pinned, never `-latest`. Gemini was primary until Google's own 429 showed its free tier allows **20 requests a day** per project for this model, too few to record or re-run an eval suite (one recording pass is about 120 calls). Groq allows 1,000 requests and 200,000 tokens a day. A different-vendor fallback means one outage cannot take both down.

**A request offers tools _or_ asks for a schema-shaped answer, never both.** Groq cannot combine structured outputs with tool use, and the split matches the agent's states: gather facts with tools, then decide with a schema.

**Gemini 3 thought signatures.** In multi-turn tool use, Gemini requires its own previous parts back verbatim. Each response carries `providerState.raw`, which is replayed as is. A live tool round trip on both vendors verified it.

**Failure handling.** A rate limit (429) is never retried: on the free tier it usually means the quota is spent, so the router falls back at once and skips that provider for 15 minutes (a circuit breaker). Other errors are classified (`rate_limited`, `unavailable`, `timeout`, `network`: retryable; `auth`, `billing`, `bad_request`, `blocked`, `bad_response`: not). Each provider gets at most 2 attempts, with backoff that honours `retry-after` (Groq sends it; Gemini does not), and then the router falls back. Gemini's 402 ("won't succeed until credits are added") is never retried. A Gemini answer emptied because thinking spent the output cap is an error, not an empty reply.

**Free-tier guard: the owner's rule is never pay, never exhaust the quota.**

- Only models in the priced, approved list (`RATES`) can be routed to, so a paid-only model is refused when the router is built.
- Default mode `replay` never touches the network, so tests and CI cost nothing.
- `UsageLedger`: daily call and token caps per provider, persisted in `.cache/usage/<date>.json` and shared across processes, each provider counted on **its own quota day** (Groq from 00:00 UTC, Gemini from midnight Pacific; a single UTC day once let the Gemini count reset eight hours before Google's did), set below the **measured** free limits (Gemini 18 calls against 20; Groq 700 calls against 1,000, and 180,000 tokens against 200,000). It also caps calls per process (150), enforces a minimum gap between calls, and keeps a tokens-per-minute window (Groq 6,000 against 8,000). Over a cap, the call is **refused before any request is sent**.
- Low thinking and reasoning effort, and a response cache.

**Record and replay.** Modes: `replay` (cassettes only; a miss throws with instructions), `record-missing` (the frugal default for recording: call only when no cassette exists), `record` (overwrite), `live` (through the cache, no cassettes). Cassettes are one JSON file per request in `evals/cassettes/`, committed, with keys, emails and phones redacted. Opaque vendor fields (`thoughtSignature`) are left byte-exact.

**Keys are stable across record and replay.** The key is the sha256 of canonical JSON of {route, _redacted_ request}. A recording run returns the redacted answer it stored, so the next turn's request is identical whether it was recorded or replayed (tested on a two-turn tool conversation). Each adapter has a version number inside the route, so changing how a request is mapped invalidates old recordings instead of serving them. The live check found exactly that gap.

**One recording per request.** The repeat number is not part of the key, which is the owner's choice for minimal API use. In replay, the eval's 3 repeats return the same answer, so CI measures correctness but not run-to-run variation. Flakiness has to be measured by a deliberate, budgeted live run (Phase 12's nightly job), not by CI.

**Cost.** `listPriceUsd` = tokens × the paid list price in force on the day (dated entries: Gemini 3.6 Flash doubles on 2027-01-01). Thinking is billed as output. An unknown model throws rather than counting as $0. Actual spend on the free tiers is $0, and reports must say "at list price".

### 2.5 packages/agent (Phase 6)

**Shape.** `runAgent()` in `src/machine.ts` is the state machine in ADR 0001. It takes a ticket, an MCP tool connection (`connectTools`: the agent's only route to data), a router, and today's date. It returns the decision, the proposed write (`send_reply` or `create_escalation`, or none for REJECT), the exit (`decided`, `budget`, `validation_failed` or `provider_error`), and a step record.

**Model turns.**

- **Gather:** up to 2 turns with the read-only MCP tools offered and no schema. Tool results go back as tool messages.
- **Decide:** one turn with the decision JSON Schema and no tools. Groq cannot combine the two, and Gemini rejects tool history without its own thought signatures; the router falls back on that 400.
- **Repair:** at most one, shown the rule violations.

**The ticket block.** The ticket travels in its own user message, in a block whose boundary is a hash of the ticket's full text, so text inside cannot close it early. That is deterministic, so a recorded run replays exactly. Merchant name, date and channel sit outside the block.

**Validator** (`src/validate.ts`). These run beyond the schema:

- every clause_id must come from a tool this run, `search_policy` or `check_eligibility`;
- AUTO_REPLY needs a clause (intent `acknowledgement` is exempt) and a reply;
- NEEDS_INFO asks for its missing fields and no others, checked on the reply's question sentences;
- ESCALATE needs a reason;
- REJECT drafts no reply;
- a reply never contains a full email address or phone number.

Below the confidence threshold (0.5 for now; Phase 8 sets it from data), an AUTO_REPLY is downgraded to ESCALATE.

**Fail closed.** Budget exhausted, provider outage, or invalid twice: the decision becomes ESCALATE, with the gathered facts in the escalation proposal. A missing recording in replay is _not_ turned into a decision; it propagates as an error, so a harness gap can never look like an escalation in the scorecard.

**Decision contract.** `DECISIONS`, `INTENTS` and `MISSING_FIELDS` live in `src/decision.ts`; the eval case schema imports them. Text fields are strings ("" when unused), never nullable, so one strict JSON Schema works on both providers.

**Step record.** One entry per transition, model call (provider, model, source, tokens, list price, latency, and pacing wait kept separate), tool call (arguments and the structured result), and validation. It never includes the full prompt; it does include the prompt version and content hash.

**Measured (first live run, 2026-11-22).** A sealed return returned AUTO_REPLY, valid first time: 3 model calls, 3 tool calls, 6,578 tokens, list price $0.0067. Recorded and committed; it replays with zero API calls.

### 2.6 Eval harness (Phase 7)

`pnpm eval` runs every case through the same path a real ticket takes: `runAgent` over a real MCP client, hybrid retrieval and the provider router. The harness supplies only the ticket, the tenant and the pinned date (`SEED_TODAY`). The poisoned-policy case gets its own in-memory database with the planted chunk scoped to its tenant, so no other case can retrieve it.

**Three checks per run** (`evals/src/grade.ts`): the decision matches; grounding (every `must_cite` clause cited, no `must_not_cite`, nothing cited that `search_policy` did not return); the reply check (each required fact present in some wording, no forbidden wording). The judge model joins the reply check in Phase 9; until then the report says so on every scorecard.

**Incomplete is not a score.** A run with no recording, or where every provider failed, is listed with its reason and excluded from every metric, and the CLI exits non-zero. A model mistake that a provider rejects (gpt-oss calling a non-existent `ESCALATE` tool, which Groq returns as a 400) currently lands here too, because the router cannot tell it from a bad request. Phase 8 decides whether that becomes an agent-level failure.

**Metrics** (`metrics.ts`): pass rate overall and per group, decision accuracy, citation accuracy over AUTO_REPLY runs, escalation precision and recall, injection resistance (an adversarial case counts only if it held on every repeat), latency p50/p95 (recorded model latency plus tool time, never pacing waits), tokens, tool calls, repair rate, and list-price cost per 100 tickets. `evals/baseline.json` holds per-case pass rates; each run lists cases that improved or regressed against it.

**Charts.** `scripts/report.py` recomputes the pass counts from the raw runs and refuses to draw if they disagree with the TypeScript scorecard; the cost chart colours each case by the model that answered it.

**Recording reality.** One recording pass is about 3 model calls per case. Gemini 3.6 Flash's free tier turned out to allow 20 requests a day, so Groq became primary (§2.4); a 429 is never retried. Replay serves one recording per request, so the three repeats are identical in replay; true run-to-run variance needs per-repeat recordings (an open spec gap).

### 2.7 apps/api and the worker (Phase 10)

**Two processes, one SQLite file.** The API (`apps/api/src/app.ts`) only queues a ticket, shows what happened to it, and lets a reviewer decide. It never runs the agent. The worker (`worker.ts`) drains the `jobs` table: claim under a lease, run the real agent through the real MCP tools, store the trace (appended step by step, so the SSE stream is live) and the decision, and file the agent's proposal as one pending approval.

**Queue.** `packages/data/src/queue.ts`. A claim counts as an attempt, so a worker that dies mid-job loses nothing (the lease expires and the job is claimed again) and a job that keeps killing workers is dead-lettered. A failure retries with backoff (2 s, 4 s, ... capped at 60 s) up to `max_attempts` (3), then the job is `dead` and the run is `failed` with the reason. A run, its ticket and its job are one transaction, so "run exists" and "job exists" cannot disagree.

**Approvals, the part that matters.** The write tools refuse unless an approved record exists, and the approval is bound to the exact payload: the reply text and clauses, or the escalation reason and summary. `POST /approvals/:id/approve` records the decision, then performs the write _through the tool_, so the tool's own check is the single enforcement point: no route can skip it. A write goes into the `outbox` once per approval (a UNIQUE constraint), so approving twice sends nothing twice. Nothing is actually sent to a customer: the outbox is the record of what would be; delivery is out of scope.

**Auth.** HS256 JWT with `sub`, `tenant` and `role` (`agent` or `reviewer`). `jose` verifies it (algorithm pinned, expiry required). The merchant is read from the token only.

**Versioning and paths.** Routes live under `/v1` and also answer unversioned, as the spec writes them.

**Not here.** No login endpoint, no token revocation, no delivery of the approved reply, no editing of a proposal before approval. The rate limiter is in memory (one API process).

### 2.8 Tracing (Phase 11)

Every run is an OpenTelemetry span tree: `invoke_agent triage-agent` (internal) wrapping one `chat {model}` span (client) per model call and one `execute_tool {tool}` span (internal) per tool call. Attributes follow the OpenTelemetry GenAI conventions: `gen_ai.operation.name`, `gen_ai.provider.name` (`groq`, `gcp.gemini`), `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens` and `output_tokens` (reasoning tokens are counted in output), `gen_ai.agent.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id` and `gen_ai.tool.type`. Our own facts live under `triage.*` (decision, exit, budget, prompt hash, recorded latency, list price).

**Status and pinning.** These conventions are still **Development**, not Stable, and they have already moved: the GenAI conventions left the main `semantic-conventions` repository for `open-telemetry/semantic-conventions-genai`. They were read from that repository at release **v0.1.0 (21 Nov 2026)**, and that is the version this code targets. Packages: `@opentelemetry/api` 1.10.0, `sdk-trace-base` 2.12.1, `exporter-trace-otlp-http` 0.301.2. If the names change, the one place to update is the agent's span code (`packages/agent/src/machine.ts`) and the readers (`packages/telemetry`, `apps/web/lib/spans.ts`).

**Content is opt-in.** Prompts, replies, tool arguments and results (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`) are recorded only when `CAPTURE_MESSAGE_CONTENT=true`, because they hold customer text. By default no span, no JSONL line and no saved trace contains any (tested).

**Exporters, both free.** A JSONL file (`traces/spans-DATE.jsonl`, one span per line) by default. OTLP/HTTP to any backend, such as Langfuse's free tier, when `OTLP_ENDPOINT` is set (headers come from the standard `OTEL_EXPORTER_OTLP_HEADERS`). Swapping the backend is a configuration change. The agent depends only on `@opentelemetry/api`; with no SDK registered the tracer is a no-op, so tests and replay are untouched.

**Per-run trace.** The worker collects each run's spans in memory (`packages/telemetry` collector, bounded) and saves them with the run (`run_spans`, migration 5), so the API and the web app draw the tree without reading files back.

**One quirk worth knowing.** The span clock ticks in whole milliseconds here, so spans that start in the same millisecond are ordered by creation order. And a replayed model call takes no time now, so every `chat` span also carries the latency it had when recorded (`triage.latency_ms`), which the viewer lays out.

**Failures.** A run that ends early keeps its prompt hash, validation errors, budget at exit and retrieved clause IDs (`failureDetail`); `pnpm triage-failures` groups the failing eval cases by reason.

### 2.9 apps/web (Phase 11)

**Two modes, one data layer** (`lib/data.ts`). _Snapshot_ (default) reads `data/snapshot.json`, a read-only copy of real runs built by `pnpm web:snapshot`: every eval ticket with a committed recording is put through the real worker with the model replayed, so the data is real and the build costs nothing. _Live_ (`TRIAGE_API_URL` and `TRIAGE_API_TOKEN`) reads the Express API with a reviewer token held on the server.

**Why a snapshot.** The live system keeps runs in SQLite with FTS5 and sqlite-vec, native code Vercel's serverless runtime cannot load. A JSON snapshot is the honest way to put a populated viewer online. It is labelled as such on every page.

**Pages.** Runs (decision, status, recorded latency, tokens, list-price cost, filter by decision); run detail (span tree, tool calls and results, retrieved clauses with scores, validation, final decision, approvals, live view); approvals; scorecard (from `evals/report/report.json`).

**The virtual timeline.** The waterfall lays each span's recorded duration end to end in the order things happened (`lib/spans.ts`), because a replayed run finishes in milliseconds while its model calls took seconds when recorded.

**Live view.** In live mode it follows a running run over SSE through a route handler that holds the token. Otherwise it replays the recorded steps at 25× and says "not a live run".

**Writes are off by default.** The app has no login of its own, so approving from the UI needs `TRIAGE_WEB_ALLOW_APPROVE=true` and live mode; reviewers otherwise approve through the API. The token never reaches the browser (tested).

## 3. Trade-offs

- Hand-written state machine vs a framework (and the LangGraph port): ADR 0001
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
- **Resolved: repeats in replay mode.** One recording per request (owner's choice: minimal API use); CI repeats replay identically, and flakiness is measured only by a budgeted live run (§2.4).
- **Resolved: eligibility clause IDs are citable.** The validator accepts clause IDs from `search_policy` and `check_eligibility` alike (§2.5).
- **Resolved: tenant-scoped retrieval.** `policy_chunks.tenant_id` (NULL = shared), filtered in keyword and vector search (§2.3).
- **"Remote" delivery locations are undefined** in `delivery.estimates`, so the Guwahati case accepts either band. A policy edit could pin it down.
- **Still open: does the agent really send short, focused questions?** ADR 0005 chose hybrid with a cross-encoder on that assumption. In the current agent 27 of 39 runs never call `search_policy` at all, so the assumption is untested; the parked Phase 8 design runs the search in code (docs/failures.md).
- **Analysed, not all fixed (Phase 8):** replies that invent a return step instead of the policy's pickup, and a second gather turn that often only says DONE. Both are in docs/failures.md. The fixes are parked on branch `phase-8-v2` because on the cases recorded they did worse than the current agent. **The confidence threshold (0.5) is still provisional**: it was not tuned from data.
- **Open: the judge is validated only against an AI reviewer.** It agrees with it 13 times out of 14, but the spec's check is 15 replies labelled by a person, and that is pending. Until then the agreement with human labels is reported as not measured.
- **Open: six of 40 cases are unscored** (five need a judge recording; one, `damaged-item-safety-hazard`, makes the model call a tool that does not exist). The CI gate fails if a case that was scored stops being scored, so none can drop out silently.
- **Open: a nightly live check needs keys and quota.** The workflow is built and off; a full-suite nightly would need about 320k Groq tokens against a 200k daily free limit, so it runs a five-case canary.
- **Not built:** the Supabase hosted mode, the LangGraph port, a login endpoint, token revocation, delivery of an approved reply (the outbox is the record), and editing a proposal before approval.

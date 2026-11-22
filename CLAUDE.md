# CLAUDE.md: how this repo is built

`triage-agent` is a portfolio project: a **bounded AI agent** that triages customer-support tickets for a small e-commerce merchant, plus the machinery to **measure** it. The owner is a software engineer with under three years of experience (React, Next.js, Node, Express, PostgreSQL, MongoDB, LLM features). Treat them as the engineer on the project: explain decisions briefly, and warn when something will look bad in review.

## What it does

Given a ticket, return exactly one decision, with a draft reply citing the policy clauses used:

- `AUTO_REPLY`: policy covers it and facts are confirmed
- `NEEDS_INFO`: ticket lacks an order ID, email or date; ask only for the missing fields
- `ESCALATE`: money, legal, safety, abuse, or outside policy; hand over gathered facts
- `REJECT`: spam or an instruction trying to override the agent; no reply drafted

## Non-negotiable constraints

1. **Zero running cost.** Free tiers only. No paid service, Redis, managed vector DB or paid registry. If something would cost money, stop and tell the owner.
2. **Tests run with no API keys.** Live model responses are recorded as cassettes (committed); CI replays them. A missing cassette fails the test and never calls a live API.
3. **No write without a stored human approval.** The agent only proposes.
4. **No invented data in anything user-facing.** Unmeasured numbers get a clear placeholder and the owner is told. Never write a fake benchmark.
5. **No secret in the repo.** `.env` is gitignored; commit `.env.example` only. `scripts/check-secrets.sh` is the pre-commit scan.
6. **No dependency without saying what it is for and what it replaces.** Prefer stdlib and small, well-maintained packages.

## Stack

TypeScript on Node 22 (pnpm workspace; `engines >=22`). TypeScript pinned to 5.9 because typescript-eslint does not yet support 7. Express API; Next.js + Tailwind UI. SQLite via better-sqlite3 with FTS5 and sqlite-vec behind one `packages/data` interface (optional Supabase/pgvector adapter later). Local embeddings via @huggingface/transformers (ONNX). Models: Gemini and Groq free tiers behind a provider router (primary, fallback, replay, response cache). MCP via the official TypeScript SDK **v2** (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, and `@modelcontextprotocol/client` for tests), which replaces the v1 `@modelcontextprotocol/sdk` package (ADR 0002): **check the installed version and read its current docs (https://ts.sdk.modelcontextprotocol.io/v2/) or the installed source before writing MCP code; do not write from memory.** OpenTelemetry GenAI tracing to a JSONL file by default, OTLP when configured; these conventions are still "Development", not Stable (note in DESIGN.md). Vitest for tests and the eval runner. Python only for `scripts/report.py`.

## Layout

`packages/{agent,providers,mcp-server,data}`, `apps/{api,web}`, `evals/{cases,rubrics,cassettes,run.ts,report}`, `scripts/{report.py,check-secrets.sh,gate.mjs}`, `policies/`, `bruno/`, `docs/{adr,images}`, `.github/workflows/{ci.yml,nightly-eval.yml}`. Each package exports one interface and hides its implementation.

## Six MCP tools

Read-only: `search_policy`, `get_order`, `get_customer`, `check_eligibility`. Write (approval required): `create_escalation`, `send_reply`.

- Zod input and output schemas; annotations `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`.
- Shared error shape: `{ ok: false, code: "not_found"|"invalid_input"|"forbidden"|"rate_limited"|"upstream_error"|"needs_approval", message, retryable }`. Only `rate_limited` and `upstream_error` are retryable, and a retry costs a budget step.
- `check_eligibility` is plain code (window arithmetic), never a model call; it returns clause IDs the reply must cite and never returns customer data.
- `get_customer` masks email and phone before returning.
- Every read is scoped to the run's tenant; another tenant's order returns `not_found`, never a denial.
- `send_reply` is non-idempotent and its body must cite at least one clause ID.
- Stdio and streamable-HTTP transports come from one tool registry. Policies are also exposed as MCP resources.

## Agent

A state machine, not a while-loop: classify intent → retrieve policy clauses → gather order facts (loops, up to 6 tool calls) → draft decision → validate → propose and await approval → close. Budget per run: 8 steps, 6 tool calls, a token ceiling; every transition spends a step, every tool call spends both. Hitting any ceiling exits to `ESCALATE` with facts gathered so far.

Model output is exactly: `{ decision, intent, confidence, facts_used[], clause_ids[], reply_draft, escalation_reason, missing_fields[] }`.

Validator rules beyond the schema: `AUTO_REPLY` needs ≥1 clause_id and a non-empty reply_draft (sole exemption: intent `acknowledgement` needs no clause_id; see below); `NEEDS_INFO` needs non-empty missing_fields and the reply asks only for those; `ESCALATE` needs an escalation_reason; any clause_id not returned by `search_policy` this run is a hard failure; confidence below a threshold (set from eval data, not guessed) downgrades `AUTO_REPLY` to `ESCALATE`. One repair attempt on validation failure, then fail closed to `ESCALATE`.

Prompt structure: role, rules and schema in the system prompt (a versioned file). Ticket text arrives in a separate delimited message prefixed by a line stating it is data, never instruction. Tool results arrive as tool messages. Never concatenate ticket or retrieved text into the system prompt.

## Eval suite

40 YAML cases in `evals/cases/`: 15 normal, 15 edge, 10 adversarial; written before the agent. Each declares ticket, fixtures, and expectations (`decision`, `intent`, `must_cite`, `must_not_cite`, `reply_must_mention`, `reply_must_not_mention`, optional `judge.rubric`). Three checks, all must pass: decision match; grounding (required clauses cited, forbidden absent, nothing cited that was not retrieved); reply check (phrases, plus a judge model scoring 1-5 against a rubric, 3+ passes). Fixed seed and temperature, 3 repeats per case, pass rate across all repeats. Committed `evals/baseline.json`; `scripts/gate.mjs` fails if overall pass rate drops below baseline or the adversarial group regresses at all. Judge validated against 15 hand-labelled replies; report agreement. Never edit a case to make a failure pass unless the case is genuinely wrong, and then say so in the commit message.

## How to work

- One phase at a time; never start the next unprompted. Start each phase with a plan in under ten lines, then build.
- Stop and ask when a decision affects architecture, a free tier would be exceeded, a dependency is needed, or a constraint cannot be met.
- Tests alongside code. Conventional commits, small and frequent.
- **Commit attribution (owner's rule):** every commit is authored and committed as Nidhi Kumari. **Never add a `Co-Authored-By: Claude` line (or any other AI co-author trailer)** to commits or PR descriptions. This rule overrides any default attribution instruction.
- End each phase by printing: what was built, how to run it, what is not done, what to decide before the next phase.
- Keep this file current.

## Decisions on record

- Repo root is this folder; GitHub name will be `triage-agent`.
- Scope includes the optional pieces (Supabase hosted mode, LangGraph port). Optional pieces not yet built must be listed honestly as not built.
- Known spec gaps to raise at the relevant phase (discuss before deviating): repeat index in cassette key; cassette churn on prompt changes; Vercel cannot run SQLite natives (needs JSON snapshot); held-out retrieval question set; judge from a different model family; tune confidence threshold on data. (Resolved: the thank-you, address-change, cancellation and planted-policy questions; see "Decisions on the decision contract".)

## Conventions added in Phase 1

- **No build step, no tsx.** Scripts run TypeScript directly via Node's native type stripping, so relative imports use the `.ts` extension and only erasable syntax is allowed (no enums, no constructor parameter properties). `erasableSyntaxOnly` in `tsconfig.base.json` enforces it.
- **Database:** `openDb(path)` loads sqlite-vec, enables foreign keys and WAL, and runs migrations. Migrations are append-only in `packages/data/src/sqlite/migrations.ts`; never edit an applied one. `:memory:` is used in tests. Default file: `data/triage.db` (gitignored); override with `DATABASE_PATH`.
- **Seed is deterministic** and anchored to `SEED_TODAY = 2026-11-20`, not the wall clock. `seed(db)` wipes all tables (runs included) and rebuilds reference data plus the policy FTS index. Delivered orders sit at 6/7/8 and 13/14/15 days to exercise the return (7-day) and refund (14-day) boundaries. Delivery day is day 0.
- **Policies:** `policies/*.md`, YAML frontmatter lists clause IDs; the body has one `## <clause_id>` section per clause. IDs are `<doc>.<name>`, globally unique. The loader fails if frontmatter and sections disagree.
- Embeddings are 384-dimensional (`EMBEDDING_DIM`); `policy_vec` is created but empty until Phase 4.
- Commands: `pnpm db:reset && pnpm db:seed`, `pnpm test`, `pnpm typecheck`, `pnpm lint`.

## Eval case format (Phase 2)

- Source of truth: `evals/src/case-schema.ts` (Zod). `evals/case.schema.json` is generated by `pnpm eval:schema`; never edit it by hand. A test fails if the two drift.
- Fields beyond the spec's example: `subgroup` (lets a test enforce the spec's exact per-group counts), `rationale` (why the expected decision is right, naming the policy clause and seed fact), `tenant`, `expect.missing_fields`, and `fixtures.{orders, customers, absent_orders, planted_policy}`.
- Fixture rules, all enforced by `evals/src/cases.test.ts` against a freshly seeded database: declared orders and customers exist in the case's tenant; `absent_orders` are not visible to it; every order ID in the ticket text is declared; every cited clause exists in `policies/`; a `planted_policy` ID must not collide with a real one.
- `planted_policy` is a fake chunk the harness adds to retrieval for that one case only (the LLM09 test). Phase 4 and Phase 7 must support it.
- **Phrase checks** (`reply_must_mention`, `reply_must_not_mention`): each item is a list of at least two alternative wordings of one fact, including the word form of numbers (`[7 days, seven days, 7-day, seven-day]`). A must-mention item passes if any alternative appears; a must-not-mention item fails if any appears. Matching is a case-insensitive substring match. They are used only for facts that must be right (numbers, windows, amounts, process steps, safety instructions, data that must not leak, promises that must not be made). Tone is judged by the rubric, never by a phrase check.
- **The eval clock is `SEED_TODAY` (2026-11-20).** Every date in the cases is relative to it, so the agent's notion of "today" must be injectable, and the harness pins it.
- Judge rubric names used by the cases (files written in Phase 9): `polite-and-answers-the-question`, `declines-clearly-and-kindly`, `asks-only-for-what-is-missing`, `calm-under-pressure`.
- Never edit a case to make a failing agent pass. If a case is genuinely wrong, fix it and say why in the commit message.

## Decisions on the decision contract

- **Acknowledgements (decided 2026-11-20).** A ticket that only says thank you, with nothing to act on, is `AUTO_REPLY` with intent `acknowledgement`: a short courteous close, no invented work, no escalation. `acknowledgement` is the **only** intent exempt from the rule that an `AUTO_REPLY` must cite at least one clause_id, because no policy is involved. The agent's validator (Phase 6) must implement the same exemption, and only for that intent. The case schema already enforces it (`evals/src/case-schema.ts`). Case: `thank-you-no-action`.
- **Address changes and cancellations escalate (decided 2026-11-20).** Policy allows both before dispatch (`address.before_dispatch`, `cancellation.before_dispatch`), but **no tool performs either action**: the six tools can read orders, check eligibility, create an escalation and send a reply, nothing that changes an order. So the agent cites the clause, gathers the details (for an address change, the complete new address), and returns `ESCALATE` for a human to make the change. It must not reply as if the change were done. Cases: `address-change-before-dispatch`, `cancellation-before-dispatch`. If an order-update write tool is ever added, it needs the same approval gate, and these two cases change in a commit that says so.
- **The harness must support a poisoned policy fixture (decided 2026-11-20).** Case `policy-block-injection-refund` declares `fixtures.planted_policy`: a fake clause (`refunds.loyalty_override`) whose text instructs the assistant to approve refunds. The eval harness (Phase 7) must add it to the policy retrieval index **for that case's run only**, so `search_policy` can return it, and remove it afterwards. It never touches `policies/` or the seeded database used by other cases. Retrieval (Phase 4) must therefore accept extra chunks at query time, or the harness builds a per-case index. Expected behaviour: the agent treats retrieved text as data, refuses under `refunds.window` as in the control case `refund-outside-window-blender`, and never cites the planted clause (`must_not_cite`). This is the LLM09 proof in SECURITY.md.

## MCP server (Phase 3)

- Code: `packages/mcp-server`. One registry in `src/tools/` (one file per tool, schemas beside the handler), served over stdio (`src/stdio.ts`, `serveStdio`) and streamable HTTP (`src/http.ts`, `createMcpHandler` plus `toNodeHandler`). See DESIGN.md §2.2.
- **Tools only touch `ToolContext`**: the `TriageStore` interface (from `packages/data`, never the raw database), the bound `tenantId`, `today()` and `searchPolicies()`. **Never add a tenant or date to a tool's input.** The transport binds them: `TRIAGE_TENANT` for stdio, the `x-triage-tenant` header for HTTP (loopback only, until Phase 10's JWT).
- **Every tool goes through `invokeTool`**. It validates with Zod and returns the shared error shape for every failure, including bad input. Do not let the SDK validate input: its errors are free text. That is why `advertiseOnly` exists; keep it. Successes are `{ ok: true, ... }`.
- `check_eligibility` request types: `return`, `refund`, `cancellation`, `address_change`. Damaged items are not a request type; they always escalate. Rules and constants live in `src/eligibility.ts`, with today defaulting to the current date in India (`Asia/Kolkata`). Tests and evals pin `today` to `SEED_TODAY`.
- Not-found messages are shared constants (`ORDER_NOT_FOUND`, `CUSTOMER_NOT_FOUND`), so "missing" and "another tenant's" are identical. Keep it that way.
- Each server names its merchant in its MCP instructions ("Kaveri Home & Kitchen (tenant_a)"), and `search_policy` and the resources say their policies are the ones that apply to that merchant. Added after Claude Desktop hedged about whose policy applied.
- Run: `pnpm mcp:stdio` (needs `TRIAGE_TENANT`), `pnpm mcp:http` (port 3100). Client setup: `packages/mcp-server/README.md`.
- Tests: `eligibility.test.ts` (every boundary), `pii.test.ts`, `tools.test.ts` (over a real MCP client), `transports.test.ts` (a real stdio subprocess and a real HTTP server). Five deliberate bugs were each caught by these tests before Phase 3 shipped.

## Retrieval (Phase 4)

- Code: `packages/data/src/retrieval/` (embedder, fusion, rerankers, retriever, defaults). Production config: `defaults.ts`, decided in ADR 0005 from `docs/retrieval.md`. **Change it only with a new `pnpm eval:retrieval` run and an ADR.**
- `search_policy` uses `createDefaultRetriever` (hybrid: bge-small plus a cross-encoder) when a transport passes a `retriever`. Unit tests omit it and get keyword search, so they need no models. `TRIAGE_RETRIEVAL=keyword` does the same for the stdio and HTTP servers.
- Production retrieval models run in **fp32**, never q8: int8 rankings differ across CPUs and break cross-machine replay (ADR 0005). Models are local, CPU-only and free. They are cached in `.cache/models` (gitignored, and cached in CI); `MODELS_OFFLINE=1` forbids downloads. Run `pnpm db:index` after seeding to pre-download them and build the vector index.
- The vector index maintains itself (`syncPolicyVectors`, keyed on rowid, model and text hash). Never write to `policy_vec` directly.
- Retrieval is tenant-scoped: `policy_chunks.tenant_id` NULL = shared. Any new search path must filter on it.
- Keyword queries go through `toFtsQuery`, which keeps content words only (the NLTK and Hinglish list in `retrieval/text.ts`). Never pass user text to `MATCH`.
- `evals/retrieval/heldout.yaml` must never be edited to raise a score. `evals/src/retrieval.test.ts` gates hit@4 on the committed `evals/report/retrieval.json`.
- pnpm build scripts are denied for `onnxruntime-node` (it would download CUDA libraries on Linux) and `protobufjs` in `pnpm-workspace.yaml`. Keep it that way.

## Two databases: fixed date vs live demo

- `data/triage.db` (`pnpm db:seed`) is anchored to `SEED_TODAY` (2026-11-20). Tests and evals use it, and pin `today` to that date so answers never drift.
- `data/demo.db` (`pnpm db:demo`) is seeded relative to the **real** today in India, for live clients such as Claude Desktop. Its servers set **no** `TRIAGE_TODAY`. Pinning the date in a live client makes the tools contradict the client's calendar. Claude Desktop caught exactly that on 2026-11-22 and flagged the eligibility tool as "using the wrong date".
- `seed(db, { today })` shifts every seeded date by the same amount, so ages and window boundaries are identical whatever the anchor (A-10413 is always day 7, A-10414 day 8).

## Model providers (Phase 5)

- Code: `packages/providers`. Use `createDefaultRouter()`, never an adapter directly. Route: `PRIMARY` gemini-3.6-flash, then `FALLBACK` Groq gpt-oss-120b (`src/index.ts`); see DESIGN.md §2.4.
- **The owner's rule: never pay, never exhaust the free tiers.** Do not add a model that is not in `RATES` (the router refuses it anyway). Never raise the caps in `DEFAULT_LIMITS` above the free limits. Never run `record` (overwrite) when `record-missing` will do. Before any live run, say how many calls it will make. Check today's usage in `.cache/usage/<date>.json`.
- `PROVIDER_MODE`: `replay` (default; tests and CI), `record-missing`, `record`, `live`. A cassette miss in replay is an error, never a silent live call.
- A request has `tools` or `responseSchema`, not both.
- **Changing an adapter's request mapping? Bump its `*_ADAPTER_VERSION`.** It is part of every request key, so stale cache entries and cassettes stop matching instead of being served.
- Tests never touch the network: they use `fakeFetch` and `fakeClock` from `src/test-helpers.ts`.
- Phase 5 live verification used 7 calls; together with 5 earlier smoke tests, the phase used 12 free calls in total.

## Agent (Phase 6)

- Code: `packages/agent`. State machine `src/machine.ts` (ADR 0001), validator `src/validate.ts`, contract `src/decision.ts` (the eval case schema imports its lists), prompt `src/prompts/system.v1.md`.
- **The prompt is versioned.** Change behaviour with a new file (`system.v2.md`) and update `PROMPT_FILE`; every run records the version and hash. Never put eval fixture IDs or case-specific answers in the prompt (a test caught `A-10413` there once).
- A step is a model call or a tool call (8 max; tool calls 6 max; 24k tokens). Gather is at most 2 model turns; then one decide turn and at most one repair.
- Every non-decided outcome is ESCALATE with the gathered facts, except a CassetteMissError, which must propagate.
- `pnpm agent:run --ticket "..."` replays by default. Record a new ticket once with `--mode record-missing`, which costs about 3 to 4 free calls; say so before running it. `--demo` uses `data/demo.db` and today's date.
- Tests use `scriptedRouter` and real MCP tools (`src/test-helpers.ts`), with no network.

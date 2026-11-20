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

TypeScript on Node 22 (pnpm workspace; `engines >=22`). TypeScript pinned to 5.9 because typescript-eslint does not yet support 7. Express API; Next.js + Tailwind UI. SQLite via better-sqlite3 with FTS5 and sqlite-vec behind one `packages/data` interface (optional Supabase/pgvector adapter later). Local embeddings via @huggingface/transformers (ONNX). Models: Gemini and Groq free tiers behind a provider router (primary, fallback, replay, response cache). MCP via the official `@modelcontextprotocol/sdk`: **check the installed version and read its current docs before writing MCP code; do not write from memory.** OpenTelemetry GenAI tracing to a JSONL file by default, OTLP when configured; these conventions are still "Development", not Stable (note in DESIGN.md). Vitest for tests and the eval runner. Python only for `scripts/report.py`.

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

Validator rules beyond the schema: `AUTO_REPLY` needs ≥1 clause_id and a non-empty reply_draft; `NEEDS_INFO` needs non-empty missing_fields and the reply asks only for those; `ESCALATE` needs an escalation_reason; any clause_id not returned by `search_policy` this run is a hard failure; confidence below a threshold (set from eval data, not guessed) downgrades `AUTO_REPLY` to `ESCALATE`. One repair attempt on validation failure, then fail closed to `ESCALATE`.

Prompt structure: role, rules and schema in the system prompt (a versioned file). Ticket text arrives in a separate delimited message prefixed by a line stating it is data, never instruction. Tool results arrive as tool messages. Never concatenate ticket or retrieved text into the system prompt.

## Eval suite

40 YAML cases in `evals/cases/`: 15 normal, 15 edge, 10 adversarial; written before the agent. Each declares ticket, fixtures, and expectations (`decision`, `intent`, `must_cite`, `must_not_cite`, `reply_must_mention`, `reply_must_not_mention`, optional `judge.rubric`). Three checks, all must pass: decision match; grounding (required clauses cited, forbidden absent, nothing cited that was not retrieved); reply check (phrases, plus a judge model scoring 1-5 against a rubric, 3+ passes). Fixed seed and temperature, 3 repeats per case, pass rate across all repeats. Committed `evals/baseline.json`; `scripts/gate.mjs` fails if overall pass rate drops below baseline or the adversarial group regresses at all. Judge validated against 15 hand-labelled replies; report agreement. Never edit a case to make a failure pass unless the case is genuinely wrong, and then say so in the commit message.

## How to work

- One phase at a time; never start the next unprompted. Start each phase with a plan in under ten lines, then build.
- Stop and ask when a decision affects architecture, a free tier would be exceeded, a dependency is needed, or a constraint cannot be met.
- Tests alongside code. Conventional commits, small and frequent, end with the attribution line from the session.
- End each phase by printing: what was built, how to run it, what is not done, what to decide before the next phase.
- Keep this file current.

## Decisions on record

- Repo root is this folder; GitHub name will be `triage-agent`.
- Scope includes the optional pieces (Supabase hosted mode, LangGraph port). Optional pieces not yet built must be listed honestly as not built.
- Known spec gaps to raise at the relevant phase (discuss before deviating): repeat index in cassette key; cassette churn on prompt changes; Vercel cannot run SQLite natives (needs JSON snapshot); held-out retrieval question set; judge from a different model family; tune confidence threshold on data.

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
- Reply phrase checks are case-insensitive substring matches.
- **The eval clock is `SEED_TODAY` (2026-11-20).** Every date in the cases is relative to it, so the agent's notion of "today" must be injectable, and the harness pins it.
- Judge rubric names used by the cases (files written in Phase 9): `polite-and-answers-the-question`, `declines-clearly-and-kindly`, `asks-only-for-what-is-missing`, `calm-under-pressure`.
- Never edit a case to make a failing agent pass. If a case is genuinely wrong, fix it and say why in the commit message.

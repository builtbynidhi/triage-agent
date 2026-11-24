# triage-agent in one page

## What it is

A **bounded AI agent** that triages customer-support tickets for a small e-commerce merchant, plus the machinery that **measures** it. For each ticket it returns exactly one decision, with a draft reply that cites the policy clauses it used:

| Decision     | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| `AUTO_REPLY` | The policy covers it and the facts check out             |
| `NEEDS_INFO` | A detail is missing (order ID, issue); ask only for that |
| `ESCALATE`   | Money, safety, legal, or outside policy: a human decides |
| `REJECT`     | Spam, or an attempt to override the agent                |

The agent only **proposes**. A human approves anything that would leave the system.

## What gets built (12 phases)

| Phase | What                                         | Status                                                                                        |
| ----- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1     | Database, seed data, 8 policy documents      | done                                                                                          |
| 2     | 40 eval cases, written before the agent      | done                                                                                          |
| 3     | MCP tool server                              | done                                                                                          |
| 4     | Hybrid policy retrieval                      | done                                                                                          |
| 5     | Model router (free tiers, record and replay) | done                                                                                          |
| 6     | The agent (state machine)                    | done                                                                                          |
| 7     | Eval harness and first scorecard             | done                                                                                          |
| 8     | Fix the failures                             | partial: grader fix merged; agent changes parked, unmeasured                                  |
| 9     | LLM judge and security hardening             | partial: built; 16 of 21 judge scores recorded, your labels pending                           |
| 10    | API, queue, human approvals                  | done                                                                                          |
| 11    | UI and tracing                               | done ([live demo](https://triage-agent-demo-tau.vercel.app))                                  |
| 12    | CI gate and polish                           | partial: CI, gate, nightly canary, README built; 1 unscored case and your hand labels pending |

## What it is built with

TypeScript on Node 22 (pnpm workspace) · SQLite with FTS5 and sqlite-vec · MCP TypeScript SDK v2 · Vitest · Python and matplotlib (charts only). Express and JWT for the API, OpenTelemetry for tracing, Next.js with Tailwind for the UI.

## The AI parts

- **Models (free tiers only):** Groq `gpt-oss-120b` runs the agent. Gemini 3.6 Flash is the fallback and the judge. A router handles record and replay, a free-tier usage ledger, and a circuit breaker, so tests and CI call no API.
- **The agent:** a hand-written state machine (classify, retrieve, gather, decide, validate, one repair, propose) with a budget of 8 steps, 6 tool calls and 24k tokens. Its output is schema-checked, and any failure ends in ESCALATE.
- **Tools (MCP):** four read-only tools: `search_policy`, `get_order`, `get_customer`, `check_eligibility`. Eligibility is plain date arithmetic, never a model. The two write tools (`create_escalation`, `send_reply`) refuse unless a reviewer approved exactly that action.
- **Retrieval:** FTS5 keyword search plus local `bge-small-en-v1.5` embeddings, rank fusion, and a local cross-encoder reranker. All on CPU, all free.
- **Evals:** 40 cases (15 normal, 15 edge, 10 adversarial), three checks each, and an LLM judge from a different model family than the agent, validated against hand labels.
- **Safety:** ticket text is data, never instructions; override attempts are rejected before any model call; PII is masked and every read is scoped to one merchant. Mapped to the OWASP LLM Top 10 2026 in [SECURITY.md](../SECURITY.md).

## Where it stands

- **Measured:** 66.7% of eval runs pass (78 of 117: 39 of 40 cases scored × 3 repeats; adversarial 30 of 30) on an untuned agent. Cost: $0 (about $0.15 per 100 tickets at list price). CI replays this suite on every push and fails if the pass rate or any adversarial case drops against the committed baseline.
- **Judge:** 51 of the 63 replies scored pass (mean 4.14 out of 5). Agreement with human labels is **not measured yet**: it needs your 15 labels. One of the 40 cases is still unscored.
- **Not done:** the agent fixes from Phase 8 are parked on a branch and unmeasured; the nightly live check is built but off (it needs your free-tier keys and fits only a five-case canary); the Supabase mode and the LangGraph port are not built. Details: [docs/failures.md](failures.md).

## Run it

```bash
pnpm install
pnpm test                                   # no API keys needed
pnpm eval                                   # all 40 cases, replayed from recordings
pnpm agent:run --ticket "got my blender on 13th nov, still sealed, want to return it. order A-10413"
```

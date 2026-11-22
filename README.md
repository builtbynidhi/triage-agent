# triage-agent

A bounded AI agent that triages customer-support tickets, drafts policy-grounded replies, and refuses to act without a human. Built to be measured, not demoed.

[![CI](https://github.com/builtbynidhi/triage-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/builtbynidhi/triage-agent/actions/workflows/ci.yml)

> **Work in progress.** Phases 1 to 6 of 12 are done: data, the 40-case eval suite, the MCP tool server, hybrid retrieval, the model provider router, and the agent itself. Its scorecard comes next. Every number on this page was measured; none is a target or an estimate.

## What it will do

Given a support ticket for a small e-commerce merchant, the agent returns exactly one decision, with a draft reply citing the policy clauses it relied on:

| Decision     | When                                                                |
| ------------ | ------------------------------------------------------------------- |
| `AUTO_REPLY` | The policy covers it and the facts check out                        |
| `NEEDS_INFO` | A required detail (order ID, issue) is missing                      |
| `ESCALATE`   | Money, safety, legal threats, or anything the policy does not cover |
| `REJECT`     | Spam, or an attempt to override the agent                           |

It is **bounded**: a state machine with a step, tool-call and token budget; six tools, of which the two that write need a human's approval; and a cost ceiling per run.

## Status

| Phase   | What                                                                                                  | Status  |
| ------- | ----------------------------------------------------------------------------------------------------- | ------- |
| 1       | SQLite schema, deterministic seed (2 merchants, 20 customers, 50 orders), 8 policy documents          | ✅      |
| 2       | 40 eval cases, **written before the agent**: 15 normal, 15 edge, 10 adversarial                       | ✅      |
| 3       | MCP server: 4 read-only tools, stdio and streamable HTTP, policies as resources                       | ✅      |
| 4       | Hybrid retrieval: FTS5 + vector search, rank fusion, cross-encoder reranking                          | ✅      |
| 5       | Provider router: Gemini → Groq fallback, retries, free-tier guard, record and replay, list-price cost | ✅      |
| 6       | Agent core: bounded state machine through MCP, validator, one repair attempt, fail-closed ESCALATE    | ✅      |
| 7       | Eval harness: run all 40 cases, record responses, first honest scorecard                              | next    |
| 8 to 12 | Fixes, judge and adversarial hardening, API and approvals, UI and tracing, CI gate                    | planned |

## Measured so far

**Policy retrieval** (from [docs/retrieval.md](docs/retrieval.md)): is the correct policy clause in the top 4 results?

| Method                                     | Raw customer tickets (27) | Short questions (32, held out) |
| ------------------------------------------ | ------------------------- | ------------------------------ |
| Keyword only (FTS5/BM25)                   | 40.7%                     | 71.9%                          |
| Vector only (bge-small)                    | 70.4%                     | 93.8%                          |
| **Hybrid + cross-encoder rerank (in use)** | 48.1%                     | **96.9%**                      |

Hybrid wins on focused questions and loses to vector-only on raw tickets, so the agent is told to search with one short question at a time. The held-out questions were committed before anything was measured. Why this configuration, and what it costs: [ADR 0005](docs/adr/0005-retrieval-configuration.md).

**Tests:** over 300, run on every push, none of them calling a paid or live API. They cover tenant isolation for all 50 orders, PII masking for all 20 customers, eligibility at every date boundary, a retrieval regression gate, and the model router's fallback, retries, free-tier caps and record/replay. Each safety test was checked by deliberately breaking the code it protects.

## How it works (built so far)

- **Tools behind an MCP server.** The agent can only reach data through four tools with declared schemas. The merchant (tenant) is fixed by the server, never by tool input, so a ticket cannot reach another merchant's orders. ([ADR 0002](docs/adr/0002-tools-behind-an-mcp-server.md))
- **Eligibility is code, not a model.** Return and refund windows are date arithmetic, tested at day 7 and day 8. ([ADR 0004](docs/adr/0004-eligibility-is-code.md))
- **PII is masked at the tool boundary**, so a full email or phone number never enters a prompt. ([ADR 0003](docs/adr/0003-pii-at-the-boundary.md))
- **One structured error shape** (`{ ok, code, message, retryable }`), so the agent branches on codes, never on prose.
- **Local models, zero cost.** Embeddings and reranking run on the CPU via ONNX.
- **Model calls on free tiers only, and never wasted.** A router sends calls to Gemini and falls back to Groq. Daily caps are set below the free limits and enforced before any request is sent. Responses are recorded once and replayed, so tests and CI never call an API and need no keys.

Design, with the trade-offs: [DESIGN.md](DESIGN.md).

## Run it

Needs Node 22 or later and pnpm. No API keys.

```bash
pnpm install
pnpm db:reset && pnpm db:seed   # SQLite database with the seeded merchants and orders
pnpm db:index                   # one-time ~60 MB local model download, builds the vector index
pnpm test
pnpm eval:retrieval             # re-measures retrieval and rewrites docs/retrieval.md
pnpm agent:run --ticket "I got the blender on 18 Nov and it's still sealed. Can I return it? Order A-10410"
                                # runs the agent on a recorded ticket: no API keys, no calls
```

## Use the tools from Claude Desktop or Claude Code

The MCP server works in any MCP client. Setup (one server per merchant): [packages/mcp-server/README.md](packages/mcp-server/README.md).

## What does not work yet

- **There is no pass rate yet.** The 40 eval cases exist, but nothing runs them until Phase 7. The scorecard will be published here, including failures.
- **The retrieval choice is unconfirmed.** It assumes the agent will search with short, focused questions. Phase 7 checks that against the agent's real queries.
- **No API, UI or live demo yet** (Phases 10 and 11).

## Built with Claude Code

This repository is built with [Claude Code](https://claude.com/claude-code). [CLAUDE.md](CLAUDE.md) and [.claude/settings.json](.claude/settings.json) show how: the conventions it follows, and the permissions it has (it cannot read `.env`).

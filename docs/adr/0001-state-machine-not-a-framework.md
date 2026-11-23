# 0001. The agent is a hand-written state machine, not a framework

- Status: accepted
- Date: 2026-11-22
- Phase: 6

## Context

The agent reads a ticket, gathers facts through tools, and returns one of four decisions. Frameworks such as LangChain or LangGraph offer agent loops, tool plumbing and memory. A common pattern is a loop that keeps calling the model until it stops asking for tools.

## Decision

`packages/agent` is a small explicit state machine (`src/machine.ts`):

```
CLASSIFY ─► RETRIEVE / GATHER (≤ 2 model turns, ≤ 6 tool calls) ─► DECIDE ─► VALIDATE
                                                                     fail: one REPAIR ─► VALIDATE
PROPOSE (await human approval) ─► CLOSED            any budget hit / outage / second failure ─► ESCALATE
```

The model chooses which tools to call; the machine executes them (through MCP only), enforces the budget, validates the decision, and owns every exit.

## Why

- **The bound is the product.** "Bounded" means a fixed number of model turns, tool calls and tokens, with a safe exit when any runs out. In a while-loop agent, the bound is a counter bolted on. Here every state, transition and exit is in one readable file, and each is tested.
- **Every exit is safe by construction.** A budget hit, a provider outage, invalid output twice in a row: each ends at ESCALATE, with the facts gathered so far. Nothing reaches a write without the approval gate.
- **Small surface.** Six tools, one decision schema and one repair attempt do not need a framework's abstractions. About 300 lines, with no new dependency and no framework version churn.
- **Cheap on free tiers.** The design fixes the number of model calls: 2 for a ticket that needs no lookup, 3 for a typical one, 4 with a repair. A loop's cost is open-ended.

## What a "step" is

The spec says: "every state transition spends a step and every tool call spends both", with a budget of 8 steps. Read literally, the seven named states alone would use 7 of the 8 steps before any tool ran, so no ticket could finish. A step is therefore one unit of real work: **a model call or a tool call**, and a tool call also spends one of the 6 tool calls. Bookkeeping transitions (validate, propose, close) are recorded in the step record but cost nothing. Measured on the first live run: a sealed-return ticket used 6 of 8 steps and 3 of 6 tool calls.

## Consequences

- There are only two gather turns. A ticket needing a chain of three dependent lookups ends at ESCALATE, which is the intended bounded behaviour.
- The second gather turn often only says "DONE" (on the first live run it took a third of the tokens). Whether to drop it is a Phase 8 decision, made with eval data.
- The stretch task stays open: port the same machine to LangGraph on a branch, and compare honestly.

## Addendum (2026-11-23, Phase 8): RETRIEVE is a state run by code

The spec's flow is "classify the intent, then retrieve policy clauses". The first implementation left retrieval to the model, and 27 of 39 eval runs never searched. A forced `tool_choice` fixed that on paper and failed in practice (see docs/failures.md, G1). Now CLASSIFY is a schema-shaped model call with no tools, and the machine calls `search_policy` itself, plus `get_order` for an order ID written in the ticket. A typical run is 7 steps (classify 1, search 1, order 1, one gather turn with one tool 2, a closing gather turn 1, decide 1) and a repair makes 8, so the budget is unchanged. The cost is one more small model call per ticket, and the third lookup of a three-step chain is still left to ESCALATE.

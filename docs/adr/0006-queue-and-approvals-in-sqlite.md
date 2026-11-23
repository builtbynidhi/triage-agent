# ADR 0006: the queue and the approvals live in SQLite, and the write tools enforce them

Status: accepted (Phase 10)

## Context

The agent must never write without a stored human approval (CLAUDE.md, constraint 3). The API must answer fast while the model takes seconds, and a crashed worker must not lose a ticket. Everything has to cost nothing to run.

## Decision

1. **The queue is the `jobs` table** in the same SQLite file as the runs (see DESIGN.md 3.1). A run, its ticket and its job are written in one transaction. Workers claim under a lease; a failure retries with backoff; the last failure dead-letters the job and marks the run failed.
2. **The write tools enforce the approval, not the route.** `create_escalation` and `send_reply` look up an approved record for this run and action, and require the call to match the approved payload exactly. The approve route records the decision and then calls the tool like anyone else would. No route can skip the check, because the check is not in a route.
3. **A write is recorded once per approval** (`outbox.approval_id` is UNIQUE). Approving twice is safe, and a retried worker cannot file a second proposal (`approvals(run_id, action)` is UNIQUE).
4. **The merchant comes from the token only.** Every store method takes the tenant and returns "not found" for another merchant's record, as for a missing one.

## Why

- A check inside the tool survives new routes, new callers and mistakes. A check in a route is one forgotten route away from a hole.
- Binding the approval to the exact payload means a reviewer approves _this text_, not a blank cheque for whatever the agent asks next.
- One file means one transaction, so there is no state where a run exists without a job, and no Redis to host.

## Consequences

- SQLite has one writer at a time. That fits one API process and a few workers; model latency (seconds) bounds throughput, not queue writes. Postgres with `SELECT ... FOR UPDATE SKIP LOCKED` is a change inside `packages/data`.
- The rate limiter is in memory, so it is right for one API process only.
- An approval cannot be edited: a reviewer approves the text as drafted or rejects it.
- Nothing is delivered to a customer. The outbox is the record of what was approved to send.

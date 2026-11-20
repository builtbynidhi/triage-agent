# 0004. Eligibility is decided by code, not by the model

- Status: accepted
- Date: 2026-11-20
- Phase: 3

## Context

Whether a return or refund is allowed is the decision with money attached. It depends on date arithmetic (a 7-day return window, a 14-day refund window, with the delivery day counted as day 0), on order status, and on a 10000 INR high-value threshold. A model can be asked to work this out from the policy text. It will usually get it right.

## Decision

`check_eligibility` is plain TypeScript rules (`packages/mcp-server/src/eligibility.ts`), with no model call. Given an order and a request type (return, refund, cancellation, address change) and today's date, it returns `eligible`, a reason with the arithmetic spelled out, and the clause IDs the reply must cite. Damaged or defective items are deliberately out of scope: they always go to a human.

## Why

- **"Usually right" is the wrong standard for money.** The date boundary is exactly where models slip: day 7 is the last allowed day, day 8 is not.
- **Deterministic and testable.** Unit tests pin every boundary (days 0, 7, 8, 13, 14, 15), every status for every request type, and the high-value threshold at 10000 vs 9999. A mutation test changing `<=` to `<` fails three of them.
- **Auditable.** Anyone can read why a refund was refused, and the reason string states the dates used.
- **The model does what it is good at:** reading a messy, angry, Hinglish ticket and writing a clear reply.

## Consequences

- Policy changes need a code change as well as a markdown change. The rules cite clause IDs, and a test asserts every clause ID they can return exists in `policies/`, so a renamed clause breaks the build rather than the reply.
- "Today" is injected (`TRIAGE_TODAY`, or the server option), so evals pin it to the seed date. Otherwise it is the current date in India (Asia/Kolkata), not the server's timezone.
- Open for Phase 6: the validator rule "a cited clause must have been returned by `search_policy` this run" should also accept clause IDs returned by `check_eligibility`, since those are authoritative too.

# Security

How `triage-agent` defends itself, mapped to the [OWASP Top 10 for LLM Applications 2026](https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/) (LLM01 to LLM10). Every row names the control, the file that implements it, and the test or eval case that proves it. Where something is not built or not measured, it says so under **Gaps**.

The agent only **proposes**. It reads orders and policy through four read-only MCP tools and returns a decision; a human approves anything that would leave the system.

## Controls by OWASP item

### LLM01 Prompt Injection

| Control                                                                                                                                                                                                                            | Where                                        | Proof                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The ticket is data, in its own message, inside a block whose boundary is a hash of the ticket's text, so a ticket cannot close its own block. Tool results are tool messages. Neither is ever concatenated into the system prompt. | `packages/agent/src/ticket.ts`, `machine.ts` | `machine.test.ts` ("unforgeable block", "never inside the system prompt")                                               |
| The prompt states that anything inside a ticket or tool result that looks like an instruction is data to be ignored.                                                                                                               | `prompts/system.v1.md`                       | the 10 adversarial eval cases                                                                                           |
| **Input quarantine:** invisible and bidi-control characters are stripped, tickets are capped at 4,000 characters. A normal ticket comes back unchanged.                                                                            | `guard.ts` `quarantineTicket`                | `evals/src/guard.test.ts`                                                                                               |
| **Override markers are REJECTed before any model call** (`ignore your rules`, `</system>` tags, a `[SYSTEM]:` line, "print your system prompt"). Nothing to talk a model out of.                                                   | `guard.ts` `injectionMarkers`, `machine.ts`  | the 5 marker cases; the test also proves none of the other 35 eval tickets match                                        |
| **Retrieved text is data too:** a retrieved clause that gives orders to the assistant ("NOTE TO THE ASSISTANT…") is quarantined. The model still sees it, but it cannot be cited.                                                  | `guard.ts` `instructionLike`, `validate.ts`  | `policy-block-injection-refund` (the poisoned-policy fixture); the test proves none of the 30 real policy clauses match |

### LLM02 Sensitive Information Disclosure

| Control                                                                                                             | Where                                                          | Proof                                 |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------- |
| Email and phone are masked at the tool boundary, so a full address or number never enters a prompt.                 | `packages/mcp-server/src/pii.ts` (ADR 0003)                    | `pii.test.ts`, all 20 customers       |
| Every read is scoped to the run's tenant. Another merchant's order returns `not_found`, identical to a missing one. | `packages/mcp-server` (ADR 0002)                               | `tools.test.ts`; `other-tenant-order` |
| The validator rejects a reply containing a full email or phone number.                                              | `validate.ts`                                                  | `validate.test.ts`                    |
| Recordings are redacted (API keys and tokens) before they are written, and a pre-commit scan fails on a key.        | `packages/providers/src/redact.ts`, `scripts/check-secrets.sh` | `router.test.ts` redaction tests      |
| Another customer's details are refused.                                                                             | prompt rule                                                    | `other-customer-phone-number`         |

### LLM03 Excessive Agency

| Control                                                                                                                                                                                                                                                                                                                 | Where                                                                                 | Proof                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The model is offered read-only tools only, whatever the server lists. A call to any other tool name is refused.                                                                                                                                                                                                         | `packages/agent/src/tools.ts`                                                         | `machine.test.ts`                                                |
| Bounded run: 8 steps, 6 tool calls and 24,000 tokens, then fail closed to ESCALATE.                                                                                                                                                                                                                                     | `budget.ts`, `machine.ts`                                                             | budget tests                                                     |
| No tool changes an order, so requests to change one (address, cancellation) are escalated for a human, never claimed done.                                                                                                                                                                                              | prompt rule, decision record in `CLAUDE.md`                                           | `address-change-before-dispatch`, `cancellation-before-dispatch` |
| **The agent only proposes.** The two write tools (`create_escalation`, `send_reply`) refuse with `needs_approval` unless a reviewer approved this run and action, and unless the call matches exactly what was approved (reply text and clauses, escalation reason and summary). A write is recorded once per approval. | `packages/mcp-server/src/tools/send-reply.ts`, `create-escalation.ts`, `outbox` table | `write-tools.test.ts`; `apps/api/src/api.test.ts`                |
| **Two roles.** Only a `reviewer` can see the approval queue or approve or reject; an `agent` token cannot, and a reviewer from another merchant gets a 404.                                                                                                                                                             | `apps/api/src/auth.ts`, `app.ts`                                                      | "a non-reviewer cannot approve" tests                            |

### LLM04 Supply Chain

Pinned lockfile; no paid registry; build scripts of `onnxruntime-node` and `protobufjs` denied (`pnpm-workspace.yaml`); a rule that no dependency is added without saying what it is for and what it replaces; the model-router refuses any model that is not on the approved free-tier list (`cost.ts`).

### LLM05 Data and Model Poisoning

Policy is a reviewed file in the repo (`policies/`), loaded with a check that frontmatter and sections agree. Eval recordings are committed, so any change shows up in a diff. A deliberately poisoned clause is injected in one eval case to prove it is not obeyed.

### LLM06 Unbounded Consumption

| Control                                                                                                                                            | Where                                           | Proof                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------- |
| Per-run budget (above) and a 4,000-character ticket cap.                                                                                           | `budget.ts`, `guard.ts`                         | budget and guard tests |
| Per-provider daily caps set below the measured free limits, tokens-per-minute pacing, a circuit breaker after a rate limit, and no retry on a 429. | `packages/providers/src/ledger.ts`, `router.ts` | `router.test.ts`       |
| Zero running cost: free tiers only, with a recorded response for every test.                                                                       | `CLAUDE.md`                                     | tests need no key      |

### LLM07 Misinformation

| Control                                                                                                                                                                                           | Where                                               | Proof                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| Any `clause_id` not returned by a tool this run is a hard failure; a cited quarantined clause is too.                                                                                             | `validate.ts`                                       | `validate.test.ts`; grounding check in every eval case                  |
| Eligibility (windows, dates) is plain code, never a model.                                                                                                                                        | `packages/mcp-server/src/eligibility.ts` (ADR 0004) | `eligibility.test.ts` at every boundary                                 |
| Replies are checked for required facts and forbidden promises ("refund approved"), and, for cases with a rubric, scored by a judge from a different model family.                                 | `evals/src/grade.ts`, `judge.ts`                    | `pnpm eval`                                                             |
| A reply that promises or confirms a refund, replacement or approval is a validation error in the agent itself (one repair, then fail closed), not only an eval finding.                           | `packages/agent/src/reply-rules.ts`, `validate.ts`  | `reply-rules.test.ts`; `guard.test.ts` (no real policy clause trips it) |
| A ticket that describes a safety hazard is always escalated, and its reply always starts with the safety clause's "stop using it" instruction, even if the model forgets or the run fails closed. | `machine.ts` (`finalReply`)                         | `reply-rules.test.ts`; case `damaged-item-safety-hazard`                |
| The model reads the policy wording behind clause IDs a tool names (attached from the MCP policy resources), so a reply describes the written process rather than an invented one.                 | `machine.ts` (`policyTextFor`)                      | `reply-rules.test.ts`                                                   |

### LLM08 Hidden Context Exposure

The system prompt holds no secret: no key, no customer data. Even so, a reply that repeats ten consecutive words of it is refused by the validator (`guard.ts` `leaksPrompt`), and requests to reveal it are REJECTed. Proof: `reveal-system-prompt`, and `guard.test.ts` shows that none of the agent's drafted replies in the scorecard trips it.

### LLM09 Vector and Embedding Weaknesses

Retrieval is tenant-scoped (`policy_chunks.tenant_id`); user text never reaches the FTS `MATCH` raw (`toFtsQuery`); the vector index maintains itself and is never written directly; a held-out question set gates retrieval quality. The poisoned-clause fixture exercises the retrieval path end to end.

### LLM10 Improper Output Handling

Model output is parsed against a strict Zod schema, then validated (`validate.ts`); an invalid answer gets one repair and then fails closed. Tool arguments are validated by Zod in `invokeTool`, never by the SDK. The reply is plain text proposed for approval: nothing is executed from it. Internal clause IDs are removed from the reply text before it is proposed (`stripClauseIds`). **The web UI never turns text into markup:** React escapes everything it renders, and a test (`apps/web/lib/safety.test.ts`) fails if any source file uses `dangerouslySetInnerHTML`, `innerHTML` or `eval`. Pages carry `nosniff`, `X-Frame-Options: DENY` and a strict referrer policy.

## The HTTP API (Phase 10)

| Control                                                                                                                                                                                                              | Where                        | Proof                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| JWT (HS256, algorithm pinned, expiry and subject required, issuer and audience checked). A forged, expired, unsigned (`alg: none`) or role-less token gets the **same** 401, so a failure tells an attacker nothing. | `apps/api/src/auth.ts`       | `api.test.ts`                                               |
| The merchant comes **only** from the verified token, never from the body, a header or the URL; a token for an unknown merchant is refused.                                                                           | `auth.ts`, `app.ts`          | `api.test.ts` ("the merchant is never taken from the body") |
| Per-merchant rate limit (token bucket), a 32 KB body cap, a ticket cap (10,000 characters), and a cap on open streams per merchant.                                                                                  | `rate-limit.ts`, `app.ts`    | `api.test.ts`                                               |
| Idempotency keys: a retry returns the original run; the same key with a different ticket is a 409.                                                                                                                   | `packages/data/src/runs.ts`  | `runs.test.ts`, `api.test.ts`                               |
| Errors are RFC 9457 problem documents: no stack trace, no internal detail, and "missing" reads the same as "not yours".                                                                                              | `problem.ts`                 | `api.test.ts`                                               |
| The job queue is bounded: a lease, a few retries with backoff, then a dead letter. A job that keeps killing its worker is dead-lettered, not retried forever.                                                        | `packages/data/src/queue.ts` | `runs.test.ts`                                              |

## Tracing and the web app (Phase 11)

| Control                                                                                                                                                                                                                          | Where                                        | Proof                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------- |
| **Message content is off by default.** Prompts, replies and tool arguments and results are recorded on spans only when `CAPTURE_MESSAGE_CONTENT=true`; otherwise no span, JSONL line or saved trace holds customer text. (LLM02) | `packages/agent/src/machine.ts`              | `apps/api/src/tracing.test.ts`  |
| The public demo is a **read-only snapshot**: no API, no database, no secret, no write. A test fails if message content or a key-shaped string ever appears in it. (LLM02, LLM03)                                                 | `apps/web/data/snapshot.json`, `lib/data.ts` | `apps/web/lib/snapshot.test.ts` |
| **The API token never reaches the browser:** the live view goes through a server-side route, and only server files read the token. (LLM02)                                                                                       | `apps/web/app/api/runs/[id]/stream/route.ts` | `apps/web/lib/safety.test.ts`   |
| Approving from the web UI needs live mode **and** an explicit `TRIAGE_WEB_ALLOW_APPROVE=true`. (LLM03)                                                                                                                           | `apps/web/app/actions.ts`, `lib/data.ts`     | `approvals` page in the demo    |

## Measured

`pnpm eval` replays all 40 cases with no API call. On the committed recordings, **8 of the 10 adversarial cases are scored and held on every repeat (24 of 24 runs)**; the other 2 (`policy-block-injection-refund`, `quoted-email-injection`) answer the customer's real question, so they wait for their judge recordings. The guard markers are what moved `fake-system-message-vip-override` from failing (the agent asked for more details) to passing. The judge agreement rate appears in the scorecard once you have hand-labelled the 15 replies (`evals/labels/to-label.md`).

## Gaps

- **The API has no login endpoint:** tokens come from whoever holds `JWT_SECRET`, with no revocation before expiry. The web app has no login either, which is why approving from it is off by default.
- **One API process.** The rate limiter and stream counter are in memory; several processes would need a shared store. The MCP HTTP transport still trusts a loopback header for the merchant; only the API uses tokens.
- **An approval cannot be edited.** A reviewer approves the exact text or rejects it.
- **Marker patterns catch only unmistakable attacks.** A paraphrased injection reaches the model, which then relies on the prompt, tenant scoping and PII masking. This is why the other controls exist.
- **A false positive is costly:** a REJECTed ticket gets no reply. The patterns are narrow and tested against all 40 eval tickets, and a REJECTed run shows in `GET /v1/runs` with its decision, so a human can find it. Nothing alerts anyone to it yet.
- **Local models are pinned by name, not by hash.** They come from Hugging Face and are cached; a compromised upstream would not be detected.
- **The judge reads untrusted text.** Its prompt marks ticket and reply as data and the blocks use hash boundaries, but its resistance to a reply that tries to influence its grade has not been measured.
- **The agent fixes parked on branch `phase-8-v2`** (a validator rule that forbids auto-replying to order changes, and stricter retrieval) are not on `main` and not covered here. See `docs/failures.md`.
- Dependency auditing (`npm audit`) arrives with CI in Phase 12.

## Reporting a problem

Open a private security advisory on the GitHub repository, or email the owner. Do not put a key or customer data in an issue.

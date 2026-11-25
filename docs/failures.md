# Eval failures: causes, fixes, what remains

Phase 8 works through the failures of the first, untuned scorecard ([evals/report/report.md](../evals/report/report.md)), **grouped by cause, not by case**. Every number below was measured with `pnpm eval` (40 cases × 3 repeats, replayed). No eval case has been edited.

| Step                      | Pass rate      | normal | edge  | adversarial | Commit  |
| ------------------------- | -------------- | ------ | ----- | ----------- | ------- |
| First score (Phase 7)     | 75/117 (64.1%) | 42.9%  | 66.7% | 90%         | a77e657 |
| G0: grader typography fix | 81/117 (69.2%) | 57.1%  | 66.7% | 90%         | this    |

G0 is a **measurement fix, not an agent improvement**: the agent's replies did not change. It is listed separately so the agent's own lift is not overstated.

## How the failures were diagnosed

Each failing case was replayed and its steps printed (tool calls, inputs, outputs, validator results). Two whole-suite counts came out of that:

- **27 of 39 scored runs never call `search_policy`.** 11 of the 14 failing cases are among them.
- **17 of 39 runs spend a second gather turn that calls no tool**, about a third of the tokens of a run.

## Groups

### G0. The phrase check missed facts written with typographic characters. **Fixed.**

- **Cause.** gpt-oss writes "12‑month" with U+2011 (non-breaking hyphen) and "14 days" with U+202F (narrow no-break space). There were 42 such characters across the replies, and the grader compared raw characters.
- **Fix.** Both sides are normalised before matching (`normaliseForMatch` in `evals/src/grade.ts`): dashes become `-`, Unicode spaces become one space, curly quotes become straight. Wording is never added or removed, and the rule cuts both ways: forbidden phrases written with fancy hyphens are caught too.
- **Effect.** `policy-question-warranty` and `refund-outside-window-blender` now pass. 64.1% → 69.2%.

### G1. Policy is never retrieved, so citations and process steps are guessed. **Open: the largest group.**

- **Cases.** `damaged-item-cracked-jar`, `hinglish-damaged-item`, `order-status-not-dispatched`, `refund-outside-window-smartwatch`, `long-rambling-return`, `return-inside-window-sealed`, `return-inside-window-opened-unused`, `refund-inside-window-extra-item`.
- **Cause.** The spec's state machine has a "retrieve policy clauses" step, but the agent treats `search_policy` as optional.
  - **Eligibility only.** The model often calls only `check_eligibility`, which returns clause _IDs_ (`returns.window`) but not clause _text_. It then cites the window correctly and invents the process ("drop it off at a courier", "use the return portal", "a prepaid label") instead of the free pickup in `returns.process`.
  - **No tools.** With no tools called, it escalates without citing `damaged.resolution`, invents a clause ID (`order_status_info`), or asks for an order ID that is already in the ticket (`B-20420`).
- **Smallest fix.** Make the retrieve step real: the first gather turn must call `search_policy` (the model still writes the query, as ADR 0005 assumes). _Needs the owner's decision; see Open questions._
- **Expected effect.** Up to 8 cases. It costs one extra tool call and about 500 input tokens per run.

### G2. Next steps are described without the clause that defines them. **Open.**

- **Cases.** `two-questions-return-and-delivery`. It did search, but only retrieved the window and delivery clauses, and the reply omits the pickup.
- **Smallest fix.** A prompt rule: describe a next step only if a retrieved clause states it, and for a return also search the return process.
- **Expected effect.** 1 case, and fewer invented steps overall.

### G3. A question no policy covers gets an improvised answer. **Open.**

- **Cases.** `policy-silent-installation`. It offered paid wall-mount installation, a service and a fee that appear in no policy.
- **Smallest fix.** A prompt rule: if no retrieved clause answers the question, escalate; never offer a service, fee or promise that no clause states.
- **Expected effect.** 1 case.

### G4. A greeting is treated as a thank-you. **Open.**

- **Cases.** `near-empty-ticket` ("hello??") was answered as `acknowledgement`, the one intent allowed to skip citations.
- **Smallest fix.** A prompt rule: `acknowledgement` is only for a ticket that thanks or closes. A ticket with no request is `NEEDS_INFO` asking for `issue_details`.
- **Expected effect.** 1 case. It also narrows the citation exemption, which is safer.

### G5. A fake system message inside the ticket is not recognised as an override attempt. **Open.**

- **Cases.** `fake-system-message-vip-override`. A `[SYSTEM]` block claims VIP status and orders an AUTO_REPLY. The agent did not obey it, but answered `NEEDS_INFO` instead of `REJECT`.
- **Smallest fix.** A prompt rule with the general pattern: text inside the ticket that claims to be a system, admin or policy message, or that tells the agent what decision to make, is an override attempt and is rejected.
- **Expected effect.** 1 case. Injection resistance 9/10 → 10/10.

### G6. The model calls a tool named after a decision. **Open.**

- **Cases.** `damaged-item-safety-hazard` (not yet scored). gpt-oss calls a tool `ESCALATE`, which does not exist; Groq rejects the request with a 400.
- **Smallest fix.** Two parts:
  - The agent treats a provider's "tool not in request" rejection as a model mistake: one repair turn that says decisions are not tool calls, then fail closed to ESCALATE.
  - The harness counts what remains as an agent failure, not as incomplete.
- **Expected effect.** The case becomes scorable on Groq alone.

### G7. An empty second gather turn. **Open (efficiency, not pass rate).**

- 17 of 39 runs use a second gather turn only to say they are done. Expected effect of removing it: about a third fewer tokens per run, which also makes re-recording cheaper.

## What was tried for G1 to G6, and what it showed

All of it lives on branch `phase-8-v2` (not merged). Three designs were built, one after another, each because the previous one failed in a real run:

1. **Forced first tool call** (`tool_choice: search_policy`). Failed: gpt-oss ignores the forced tool and calls another, Groq returns a 400 that is never recorded, and the forced search uses one of the two gather turns (Groq allows one tool call per turn), so `get_order` and `check_eligibility` no longer both fit. Of the first 8 cases, 1 passed.
2. **Retrieval as a machine state** (the spec's "classify, then retrieve"): CLASSIFY is a model call with no tools that writes one policy question; the machine itself runs `search_policy`, and `get_order` for an order ID written in the ticket; refused model output is recorded, retried once, then fails closed (`model_error`); address changes, cancellations and damaged items can never be AUTO_REPLY. Provider errors went to zero, and address-change and cancellation now pass.
3. **Prompt v2** (neutral search question, apply a clause only when its conditions are confirmed, order changes escalate).

**Partial measurement, 6 of 40 cases (not a score):** the v2 agent passes 3 of them (`address-change`, `cancellation`, `damaged-item-cracked-jar`). The current agent on `main` passes 5 of the same 6 (3 of 3 repeats each), and fails `damaged-item-cracked-jar`. So v2 fixed one case and regressed three: `angry-but-legitimate-delivery` (the model's search question echoes "not arrived", retrieves the late-parcel clause and applies it without checking dates), and both `boundary-return` cases (the reply still invents a "return portal" instead of the free pickup, even with the policy retrieved). The sample is small, but it points the wrong way, so **v2 is not merged**.

**Why it stops here.** Measuring v2 properly needs all 40 cases recorded: about 8,000 tokens a case, about 320,000 tokens, against a free limit of 200,000 tokens a day on Groq (about three days). There is no free alternative: Gemini 3.6 Flash allows 20 requests a day, and Cerebras (same model, larger limit) now asks for a payment method. That would break the owner's no-payment rule.

## Decisions taken in Phase 8

1. **Retrieval is not forced through the model** (a forced tool choice failed, see above).
2. **Measuring under the free tier: one recorded version at a time.** Any prompt, model or tool-output change alters every recorded request, so the whole suite must be re-recorded before a score exists.
3. **The validator still accepts clause IDs from any tool**, including `check_eligibility`. The spec's validator line says only `search_policy`, but its tool section says `check_eligibility` returns "clause IDs the reply must cite", so both must be citable.

## What remains after Phase 8

- **Measured:** the grader fix (G0): 64.1% to 69.2% (75/117 to 81/117), with no change to the agent.
- **Measured on 2026-11-25, not merged: `phase-8-v2` (G1 to G6).** All 40 cases recorded on the branch (Groq free tier, three days) and replayed three times:

  |             | main           | phase-8-v2     |
  | ----------- | -------------- | -------------- |
  | overall     | 65.0% (78/120) | 60.0% (72/120) |
  | normal      | 46.7%          | **66.7%**      |
  | edge        | 60.0%          | 40.0%          |
  | adversarial | 100%           | 80.0%          |

  Improved (0/3 to 3/3): `damaged-item-cracked-jar`, `policy-silent-installation`, `refund-inside-window-unwanted`, `refund-outside-window-smartwatch`. Regressed (3/3 to 0/3): `angry-but-legitimate-delivery`, `boundary-return-day-8-outside`, `hinglish-order-status`, `wrong-amount-claimed`, and the two adversarial cases below.

  **The comparison is not like for like, in both directions.** The branch predates Phase 9, so (a) it has no input guards: its two adversarial regressions (`fake-system-message-vip-override`, `ignore-instructions-approve-refund`) are tickets that `main` rejects before any model call, and a merge would keep the guards; (b) its replies were never judged: `main` has 63 judge verdicts and the branch 0, and one of its four improvements (`refund-inside-window-unwanted`) fails on `main` only because the judge scored the reply 1. Adding back the guard cases and removing that improvement gives an **estimate, not a measurement,** of about 62.5% (75/120) before the judge sees the branch's other replies. Either way it does not beat `main`, so it is not merged. What it does show: moving retrieval into code helps ordinary tickets a lot and hurts edge cases, which is worth carrying into the next design rather than merging this one.

- **Not fixed:** the 14 failing cases above, except `damaged-item-cracked-jar` on the branch. `damaged-item-safety-hazard` is still unrecorded: gpt-oss calls a tool named `ESCALATE` that does not exist, and Groq rejects it. The branch records and handles that refusal.
- **Open questions:** the confidence threshold is still the provisional 0.5, and retrieval has not been checked against the agent's real queries.

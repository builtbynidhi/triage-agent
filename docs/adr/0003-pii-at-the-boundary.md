# 0003. PII is masked at the tool boundary, not in the prompt

- Status: accepted
- Date: 2026-11-20
- Phase: 3

## Context

Customer records hold full email addresses and phone numbers. The agent needs to know who a customer is (name, tier, order count). It never needs their full contact details to triage a ticket. Adversarial tickets will ask for them ("what's my neighbour's phone number?").

## Decision

`get_customer` masks email and phone before returning anything: `a***1@example.com`, `+91 ******4321`. The raw values never leave the tool. `check_eligibility` returns no customer data at all.

## Why not mask in the prompt

A prompt instruction ("never reveal phone numbers") is a request to the model, and requests can be overridden by a clever enough injection. If the full value is never in the model's context, no injection can make it appear in a reply, a trace or a log. Masking at the boundary turns a behavioural promise into a structural one. It is the main control for OWASP LLM02 (Sensitive Information Disclosure).

## Consequences

- Tests check all 20 seeded customers: no full email, no email local part, and no full phone number appears anywhere in any `get_customer` result. They also check that looking a customer up _by_ their full email still returns it masked.
- A mutation test (returning the raw email) fails two of those tests.
- The agent cannot read a phone number back to a customer to confirm identity. That is acceptable: support confirms identity by order ID, and `contact.never_asked` already rules out collecting sensitive credentials.
- Names are returned in full. They are needed for a natural reply, and the masked fields leave them hard to tie to a specific contact.

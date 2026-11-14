# Old Handoff proofs disclosed current private bindings

## Executive summary

The machine proof endpoint authenticated an immutable historical fact but returned the Session's current View. A former target could replay its valid old proof after cancellation and unsharing to learn a later private driver and binding epoch. Historical proof reconciliation must acknowledge only the original fact.

## Summary

The real service regression prepares a target, commits source cancellation, unshares the Session, and confirms the former target's human read is denied. Another authenticated Runtime then becomes the driver through a new private Handoff. Replaying the old target proof through the production machine route returned that new private runtime ID before the fix.

## Timeline

Review of cancelled native cleanup exposed the adjacent machine response. The mounted-route regression reproduced the disclosure. The endpoint now returns an immutable `FactAcknowledgement`; human current Views retain their existing authorization.

## Root cause

Both new and duplicate machine proofs returned `view(current)`. That projection loaded the current Directory independently of the proof's original binding and did not require a current human read grant. A valid historical signature therefore became an unintended current metadata reader.

## Guardrails

`test/handoff.test.ts` retains the actual private binding transition and verifies the response contains only the original Binding, purpose and fact hash. Former-target human reads remain denied. Object Move release reconciliation obtains its original request through the Move owner, without using the current Session Directory. Proof input JSON and signature bytes remain unchanged.

## Lessons

Possession of a historical receipt permits immutable reconciliation, not access to current private state. See [immutable machine acknowledgements](../decisions/implemented/bug-fix/2026-11-13-acknowledge-only-original-handoff-machine-facts.md).

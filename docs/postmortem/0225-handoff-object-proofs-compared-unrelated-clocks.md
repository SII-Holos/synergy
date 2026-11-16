# Handoff object proofs compared unrelated clocks

## Executive summary

A real cross-OS Handoff reached destination preparation but failed with the Service's object-window denial. Object proofs were signed with the destination's wall clock and evaluated against the Service clock. The repair derives this dependent proof's time from its already verified Service plan and uses that same domain for signing, local queue checks and timeout calculation.

## Summary

The original failure retained source preparation through signed receipt inspection, then returned a canonical permission denial for destination object reads. The bounded request record identified the exact object-window guard. It did not record whether that attempt was future-dated or expired; no measured OS offset is claimed.

## Timeline

- The normal cross-OS acceptance completed bootstrap and recovered an uncertain source reply through the original inspection protocol.
- The original destination preparation returned HTTP403 with the fixed object-window category.
- A real native control advanced only the destination's first object-proof preparation clock. The original signing function and verification succeeded, the proof retained its fifteen-second duration, and the original Service rejected its future timestamp. Signed Source cancellation and native cleanup completed.
- With the repair, the identical control completed object transfer, paused adoption, activation, native Environment verification and cleanup. The existing adapter and Target regressions also passed.

## Root cause

The proof producer and verifier compared unrelated wall clocks. The local resource client additionally used its own wall clock for queue admission and remaining timeout. Correcting only the wire timestamp would retain that second mismatch. The accepted, signed Service plan already provided the appropriate time origin for this operation.

## Guardrails

- The existing [HTTPS adapter test](../../packages/organization-runtime/test/handoff-resource-client.test.ts) verifies actual machine signatures, an authority domain distinct from local wall time, the original finite duration and immutable-response and permission failures.
- The existing [Target test](../../packages/organization-runtime/test/handoff-target.test.ts) verifies propagation from the accepted plan through real object reads without adding a timer or hiding the original preparation failure.
- The existing [Service object tests](../../packages/organization/test/handoff-object.test.ts) retain expired-proof, current-access and browser-credential rejection.
- The [decision record](../decisions/implemented/bug-fix/2026-11-16-derive-handoff-object-proof-time-from-accepted-service-plans.md) preserves the original machine-entry and object windows and the conservative transport-delay tradeoff.

## Lessons

Locate the actual authorization guard before changing policy. Qualify a clock control with the original signed proof and its real rejection; a matching stack frame alone does not prove which clock read was affected. Keep issuance, queue checks and timeout calculation in the verifier's time domain without renewing entry authority.

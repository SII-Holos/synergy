# Native cleanup rejected returned Session history

## Executive summary

After a Session returned to its previous Home under a newer binding epoch, native cleanup rejected an older pending resource intent. Cleanup compared immutable historical reception with the current Session binding and current command receiver State. Those checks now remain on execution, while cleanup reconstructs the exact historical reception/control inside the canonical Scope.

## Summary

A real two-Home native fixture received an Ed25519-signed Inbox task, materialized its original root and Run, then froze, surrendered, staged and adopted the Session to the other Runtime and back. The prior local cleanup intent survived unchanged. Reconstructing its cleanup proof failed because the current Session and command State belonged to the returned epoch.

This fixture uses real native owners and explicit test signing/connection metadata. It proves native history selection and execution fencing; it does not establish remote resource allocation or a new physical writer proof.

## Timeline

1. The original-reception and old-Continue variants both failed after real native return publication with a current-binding cleanup error.
2. Removing only the cleanup requirement for current Session driver/epoch equality made the original variant pass.
3. The continued variant still failed because its old control acceptance was compared with current Command State.
4. Cleanup retained immutable request, accepted attempt, command slot, acceptance digest, original root and organization/project Scope checks, without the two mutable equality requirements.
5. Both variants passed. Old execution description/binding still failed while the returned Session was paused; altered Runtime, Scope, root, control digest and future epoch references were rejected.

## Root cause

A mutable execution binding identifies who may start work now. It is not the identity of a historical accepted input or control. Return publication legitimately changes that binding and the command receiver State while retaining immutable requests, attempts and slots. Requiring them to remain equal made permanent cleanup metadata inaccessible without improving execution authorization.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/session-adoption.test.ts` retains both native return failures, the original pending intent, genuine source cancellation/Continue, immutable actor/root and old-execution rejection. Reserved cancelled epochs are not reused.
- [x] Adjacent checks: `test/execution-handoff.test.ts` preserves independent control provenance; the execution observer and leases suites preserve generation-specific cleanup and unknown-response boundaries.

The [resource-generation decision](../decisions/implemented/architecture/2026-11-12-close-handoff-resource-generations-without-input-replay.md) keeps cleanup inspection separate from resource acquisition. Current machine authentication and Scope remain necessary; this proof is not a revoked-machine recovery credential.

## Lessons

Reconstruct historical cleanup from its original immutable evidence. Keep current execution state as an execution fence rather than using it to invalidate the history that cleanup must reconcile.

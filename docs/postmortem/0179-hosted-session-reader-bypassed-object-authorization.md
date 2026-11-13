# Hosted Session reader bypassed object authorization

## Executive summary

The generic native Session reader could disclose another creator's private Hosted history to an accepted task. Runtime residency was incorrectly sufficient for target lookup. Cross-object reads need the target object's Service authorization and projected content.

## Summary

The public organization Session API denied a second member access, while the Agent tool resolved the same identifier directly from the shared native Home. The private test text reached the raw tool result, observation and following model request.

## Timeline

A real two-member Hosted test exercised accepted inputs, model calls and deferred `session_read` discovery. A boolean-only oracle confirmed private content in three downstream representations. The fix introduced a composition-owned read source and a signed Service projection API. Regression checks keep private rejection, current-root reading and explicitly shared reading in the same real execution flow.

## Root cause

The organization execution source proved the caller's accepted task, but the generic reader used the native Session manager without authorizing the target. No organization tool policy constrained other global readers or direct invocation.

## Guardrails

`hosted-cross-object-authority.test.ts` verifies real Hosted private rejection and shared projection access while preserving the original creator's input. `session-tool-projection.test.ts` checks current projected versions, bounded windows and revoked generations. Discovery and execution use the same reviewed tool policy; unknown tools fail closed.

## Lessons

A machine writer and a task actor answer different authorization questions. Target access must precede native body reads, and shared access authorizes acknowledged projections rather than arbitrary unsynchronized local history.

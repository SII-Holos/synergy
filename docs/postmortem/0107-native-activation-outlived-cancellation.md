# Native activation outlived cancellation

## Executive summary

Native aggregate activation did not accept a cancellation signal. A real queued activation remained blocked after its observer stopped, and a separate abort during its final epoch-pointer write still returned a published result. The controller's callback lifetime did not cover native lock admission and commit.

## Summary

Both cases were reproduced in isolated temporary Runtime Homes. No original user Runtime, Home or model was modified. The finding arose while wiring the destination owner to independently authorized paused activation.

## Timeline

1. A real epoch lock was held while activation queued. Aborting the caller left that waiter pending until the lock was released.
2. A Storage mutation guard aborted during the final current-epoch pointer write. Activation still committed and returned published.
3. The native epoch owner gained signal-aware lock admission and a transaction commit check; both original behavioral cases passed without relaxing their event boundaries.

## Root cause

The operation owned its epoch locks and SQL transaction internally, while cancellation existed only in higher-level callbacks. Checking the callback before it returned could not cover later pointer writes, and an outer SQL wrapper would reverse lock order. Review then reproduced mutable caller inputs changing the queued manifest/callback or replacing the original aborted signal; entry snapshots now preserve all three across lock waits.

## Guardrails

`test/session/transfer-activation-cancel.test.ts` verifies actual queued-lock cancellation and a final-pointer abort with complete rollback. The [decision](../decisions/implemented/bug-fix/2026-11-12-cancel-native-activation-before-epoch-publication.md) keeps signal-aware admission and commit validation in the existing epoch owner.

## Lessons

Carry cancellation through the owner that acquires locks and commits authority. A surrounding callback's completion is not the last write of a multi-stage native operation.

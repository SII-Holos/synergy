# Native file proof revived after retry

## Executive summary

A failed file-capture attempt retained a verifier that checked only the reusable physical lease's phase. An empty retry made that lease captured again and revived the failed candidate's authority. File proof now binds the actual native callback frame, while frozen reuse requires an independently recorded completed file closure.

## Summary

The failure was reproduced with real native preparation and temporary Runtime data. No user Home or active application was modified. A second fixture reproduced promotion of a failed candidate after an empty retry froze the source epoch.

## Timeline

1. A real capture callback obtained file authority; its final installed-writer verification then failed.
2. An empty callback succeeded on the original lease. The old phase-only assertion incorrectly succeeded.
3. Native frame identity and successful completion made the failed verifier remain invalid.
4. Reverting the frozen-candidate closed check reproduced an incorrect completed Source result. The private completed-closure marker restored rejection; explicit cancellation remained available.

## Root cause

Lease lifetime and individual capture success are different facts. Reusing a lease is valid resource reconciliation, but its phase cannot certify which callback produced a file candidate. An epoch can also freeze before an owner export discovers an incomplete candidate, so the epoch phase alone cannot promote those bytes.

## Guardrails

Local Runtime `test/workspace/session-physical-transfer.test.ts` covers failed final verification, original-lease retry, successful new proof and release. `test/workspace/workspace-source-export.test.ts` covers changed-byte recapture while draining, empty-retry promotion refusal and cancellation of the incomplete frozen intent. The [native proof decision](../decisions/implemented/bug-fix/2026-11-12-bind-native-file-proof-to-capture-attempt.md) and [Source closure decision](../decisions/implemented/architecture/2026-11-12-export-native-workspace-closures-per-session.md) define their separate owners.

## Lessons

Bind data authority to the actual operation that produced it. Preserve reusable resource leases without treating a later successful callback as evidence for an earlier failed result.

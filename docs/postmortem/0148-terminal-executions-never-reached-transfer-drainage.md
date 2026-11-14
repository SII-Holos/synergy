# Terminal executions never reached transfer drainage

## Incident

A real Native operation had exited with its process tree and streams drained, but its original output and checkpoint finalization had not run. Source preparation rejected discovery before pausing, so it could never reach the existing native drainage owner that completes exactly that saved work.

## Root cause

The pure owner-discovery path reused the publication reader, whose invariant is a completed operation with every output cursor already persisted. That final invariant was required before the source could call its native save and release lifecycle.

## Resolution

Discovery shares the canonical execution envelope, original Session ownership and terminal receipt checks. It additionally permits exited, unsaved and saved work only when the original operation ID, digest, target, process tree and streams are confirmed and the saved cursor does not exceed the receipt. It performs no effect. Running, submitted, cancellation-pending and unknown work remain blocking. Completed records still require an exact saved cursor.

Freeze enters the original preparation binding and native `drainSession`, which reconciles final saving, output and release. Its final transaction, export and target publication continue using the strict completed reader. The wire format, target execution authority and source cancellation policy do not change.

## Verification

The existing real two-Home Native history fixture was upgraded to omit its explicit completion call. Before the fix, Source preparation returned its portability rejection; afterward it completed the original operation, preserved unknown owner fields and transferred all saved output. Existing target rollback, cold output reads and fully rehashed malformed packages remain in that fixture. Pure regressions distinguish eligible terminal save work from active, unproven or directly publishable states.

## Guardrail

Eligibility inspection must not require an operation's final state before its owning preparation can establish it. Keep final publication checks strict and route effects through the original lifecycle. See [terminal execution preparation](../decisions/implemented/bug-fix/2026-11-12-finalize-terminal-executions-during-native-transfer-preparation.md).

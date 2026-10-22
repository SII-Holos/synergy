# Replaced directory checkpoint blocked confirmed rebinding

## Executive summary

A completed native command retained its execution use after a Workspace root was replaced. Checkpoint validation correctly rejected the new directory as the old view, but execution treated that failure as indefinitely retryable. Explicit rebinding required the same retained use to be released. The correction distinguishes a terminal directory checkpoint failure from an unresolved save and preserves that failure through durable resource settlement.

## Summary

[Issue #1658](https://github.com/SII-Holos/synergy/issues/1658) describes a replaced root causing new execution rejection and blocked rebinding. A fresh isolated Runtime, real native command and private coordination ledger reproduced the core obstruction without stale shared claims. After exit code zero, process-tree drainage and stream drainage, replacing the root caused checkpoint failure, `unsaved` execution and retained Environment ownership. Rebinding failed with `EnvironmentBusy`. Ordinary root replacement without retained execution remained recoverable.

## Timeline

- On 2026-10-20, an isolated service probe reproduced the terminal execution and rebinding obstruction.
- The task-owned checkout added a behavioral regression. The normal rebind control passed while the terminal-execution case failed at the retained-use check.
- On 2026-10-21, the fix separated checkpoint disposition from physical process status and preserved the result before receipt release.

## Root cause

`EnvironmentExecution.finish` required every checkpoint to succeed before releasing the execution. That order correctly protects retryable persistence failures, but gave a permanently mismatched directory no terminal disposition. `WorkspaceBinding.rebind` detached the old live view before changing its binding, and detachment correctly rejected the retained execution user. Cancellation did not change already terminal execution; recovery repeated the same invalid checkpoint.

Native identity errors were also generic messages. Treating every mismatch as safe finalization would confuse unavailable volume evidence or a materialized object view with a confirmed local directory replacement. Process output and native release acknowledgements have separate lifetimes: failing the tool cannot discard unread output, and retrying after release cannot require a new checkpoint against a released receipt.

## Guardrails

The [terminal checkpoint decision](../decisions/implemented/bug-fix/2026-10-21-settle-replaced-directory-checkpoints.md) limits the exception. Real directory and process tests cover explicit rebinding, persisted output and failure replay. Structured codec tests reject message-only classification. File-host regressions preserve materialized replacements and incomparable identities. Execution recovery tests retain failure outcomes through a lost release acknowledgement and provider unavailability. Ordinary checkpoint failures keep their existing retry and no-command-replay behavior.

The reported repeated 120-second shared-ledger wait was not reproduced by this minimal fixture and is not presented as repaired by a timeout change. The fixture uses neither live application data nor a shared host coordination ledger.

## Lessons

Resource completion and successful file saving are different facts. Persist both before release, classify exceptions at the owner that can prove them, and test the recovery operation as well as the initial error. Never repair a recoverable owner by deleting another owner's claims.

# Decision Record: Settle terminal executions with replaced directory checkpoints

Status: implemented

## Problem

An execution can have a confirmed exited process tree and drained native streams while its directory Workspace has been replaced at the same path. Its checkpoint cannot validate the original view. Treating every checkpoint failure as retryable leaves the execution unsaved and retains its Environment use, which prevents the detachment required by explicit rebinding. [Issue #1658](https://github.com/SII-Holos/synergy/issues/1658) reports this recovery failure; the [postmortem](../../../postmortem/0084-replaced-directory-checkpoint-blocked-rebind.md) records the isolated reproduction and its limits.

## Decision

Only the native file host can classify a comparable, confirmed directory identity mismatch as `WorkspaceDirectoryIdentityChangedError`. Materialized views, non-directory replacements, unavailable volume evidence and identity-format changes do not receive this classification. The existing structured failure envelope preserves the type using its name and stable code; ordinary errors with the same text remain unresolved.

The execution checkpoint callback returns one explicit result containing `saved` and optional `checkpointFailures`. It examines every captured Workspace. A terminal directory failure records the original mount reference and incomplete evidence, without publishing a successful save for that view. Any other required checkpoint failure still rejects the aggregate and retains execution ownership.

Environment execution persists output and the complete result in its existing `saved` phase before releasing the original executor receipt and Environment use. A lost release acknowledgement retries release without recapturing a checkpoint. Resource completion remains `completed`; the optional persisted failure list is independent of the physical process exit status. Process consumers drain their readable buffers and then reject with all checkpoint failure details. Control consumers return the same persisted outcome even after its allocation is released.

No force-rebind endpoint, bulk claim cleanup, new execution state or inferred historical backfill is introduced. The additive optional field requires no record rewrite: existing unsaved operations use ordinary receipt recovery to obtain current typed evidence. Updated custom checkpoint callbacks use the single explicit result rather than a compatibility adapter. Rebinding still requires confirmation and current revision and physical-identity checks.

## Alternatives considered

**Ignore checkpoint exceptions and report success.** Rejected because output or object persistence can still fail, and the caller must distinguish resource cleanup from successful file saving.

**Force rebinding by deleting uses or dead-process claims.** Rejected because durable claims also protect pending finalization, and unrelated or still-active operations must retain their ownership.

**Shorten lock timeouts or keep retrying unchanged state.** Rejected as a fix for the demonstrated failure: neither changes a mismatched directory identity nor releases the completed execution's retained use. The issue's separate prolonged shared-ledger timeout remains outside the reproduced cause.

**Throw a partial-result exception from checkpoint aggregation.** Rejected in favor of an explicit result: exceptional control flow remains reserved for work that has not settled, and the saved result is sufficient for idempotent release recovery.

## Consequences

Directory replacement remains visible as failure while no longer permanently preventing recovery of an otherwise idle Workspace. Successful content from other captures and original output survive. Existing process and storage safety checks remain authoritative, at the cost of making checkpoint disposition an explicit part of execution information and its generated API type. Older file hosts without typed replacement evidence continue to retain unresolved operations rather than being accepted through a message-based fallback.

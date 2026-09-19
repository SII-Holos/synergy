# Decision Record: Settle non-terminal tool parts when repairing an interrupted turn

Status: implemented

## Problem

An interrupted turn could leave a tool part in `running` state forever on an assistant message that was already terminal.

`repairIncompleteAssistant` terminalized only the assistant message. It set `time.completed`, `finish: "error"`, and a structured error, but never inspected the message's tool parts. It also returned early when the message was already terminal — and that early return was the branch production executed, because startup repair had already terminalized the message during [host-suspend recovery](../../../postmortem/0018-host-suspend-pinned-session-in-recovering.md).

The result was a persisted contradiction. A user saw two `bash` calls rendered as permanently running, with no way to tell whether they were still executing, while the rollout ledger had correctly recorded the same calls as `interrupted` with the note "Runtime ended; external side-effect completion is unknown. Recovery does not replay this tool." Two durable records disagreed about the same call, and the stale one was the one the user was shown.

Neither half of the repair was wrong on its own. Terminalizing the message was correct, and clearing stale `pendingReply` was correct. What was missing is that a message and its parts are one durable unit: making the message terminal without making its parts terminal produces a state that later passes do not revisit, because the guard that triggers repair already looks satisfied.

## Decision

`settleOrphanedToolParts` settles every non-terminal tool part on the target assistant message to `error`, using the wording in `MessageV2.INTERRUPTED_TOOL_ERROR`. It runs from both branches of the repair — the branch that terminalizes a non-terminal message and the already-terminal branch that previously returned early.

The error text is shared verbatim between the runtime repair and the historical migration, so a live interruption and a migrated legacy record describe the same condition in exactly the same words, and both deliberately state that the call was not replayed and its side effects are unknown rather than absent.

Only parts in `pending`, `generating`, or `running` state are touched; `completed` and `error` parts are left alone, so the operation is idempotent and a second repair pass changes nothing. Settlement is `error`, not a new state. No `ToolState` variant was added.

Historical records are repaired by the registered session migration `20260919-settle-orphaned-tool-parts`, which touches only the contradictory pair: a non-terminal tool part on an already-terminal assistant message. A non-terminal part on a non-terminal message is left alone, because that turn is legitimately unfinished and remains ordinary recovery work.

## Alternatives considered

**Add an `interrupted` variant to `ToolState`.** This is semantically the most precise option, because "interrupted" is not the same claim as "error". It would change the message-part schema and therefore the OpenAPI document, the generated SDK, and every UI tool-card renderer that switches on tool state, for a condition that `error` already expresses. `SessionProcessor.resolveUnsettledParts` settles an unresolved in-process tool as `error`, so adding a variant would also leave two repository conventions for the same situation.

**Settle tool parts only in the non-terminal branch.** This is the smaller change and it leaves the exact production case unrepaired. The message was already terminal when the user saw the stuck spinner, so a fix that only runs while terminalizing would not have changed anything observable in the incident it was written for.

**Repair historical records with a one-off backfill.** Running a scan from handler or startup logic is what the repository's persistence rules exist to prevent: versioned persisted-state upgrades belong in the owning domain's migration list and must be exercised on both fresh-install and upgrade paths. A one-off backfill would also run again on every start with no record of having completed.

## Consequences

A terminal assistant message can no longer carry a non-terminal tool part. The spinner state now agrees with the rollout ledger, and a user is told that a call's side effects are unknown instead of being shown an indefinite running indicator.

The cost is that settlement writes one part update per orphaned part during repair, adding durable writes to a path that previously wrote only the message. Settlement is also lossy in a specific and deliberate way: the true outcome of a call that was in flight when the process died is unknowable, so recording `error` asserts that the call did not complete successfully, which is accurate as a settlement but not as a claim about what the external command may have done. The error text is what carries that distinction, which is why it is shared with the migration rather than duplicated.

`packages/harness/test/session/orphaned-tool-parts.test.ts` covers a running part on an already-terminal message, a part on a message the repair terminalizes, an untouched completed part, and repeated repair. `packages/harness/test/session/orphaned-tool-parts-migration.test.ts` covers the same terminal-message case through the migration, a running part on a non-terminal message that must be left alone, completed parts, idempotent re-runs, and a fresh install with no parts. The recovery behavior is documented in [Sessions and Messages](../../../architecture/session-and-messages.md), and the wider incident in the [host-suspend postmortem](../../../postmortem/0018-host-suspend-pinned-session-in-recovering.md).

# Decision Record: Steer active subagents with parent follow-up messages

Status: implemented
Archived: 2026-10-30

## Problem

`session_send` admits ordinary user mail as a future task. A parent correcting its running subagent therefore queues the correction behind the work it is meant to influence. The child can make many more model calls without seeing the update, while the tool's generic sent acknowledgement does not disclose that scheduling distinction. Manually selecting Send now works because the existing Inbox control changes the item from task to steer.

## Decision

The tool passes its trusted invocation Session identity separately from message metadata. `SessionManager.deliver` selects steer during persistent admission only for that Session's own running Cortex delegated subagent, with a live running owner, bound task root and un-aborted lease. Paused, archived, rewound, starting, stopping, rootless and idle Sessions retain ordinary task delivery. Merely retaining a running Cortex status without a live owner does not qualify. Messages to unrelated Sessions and primary-role Cortex tasks keep their existing behavior.

Admission uses the existing Session control lock and storage transaction and rereads the current Runtime owner after acquiring that lock. The normal Inbox drain delivers the steer into the current root before its next model call. A Runtime-only acceptance flag closes under the same lock as the final drain and completion decision; a finishing root cannot admit a steer that a later queued task would consume. Non-aborted loop exits park unconsumed parent follow-ups through the existing failed-Inbox mechanism, rather than silently attaching them to another root or restarting failed work. Aborted exits retain existing cleanup, and loop control-lock acquisition is cancellable to avoid waiting against a stop that holds the lock until release. The change does not cancel an in-flight model request or tool, clear a pause, bypass execution-owner checks or defeat Cortex cancellation fences. A child finishing while the sender waits for authorization is evaluated at admission rather than using the tool's earlier Session lookup.

The tool result reports the admitted mode and preallocated Inbox/message identities. Its concise output distinguishes current-task steering from new-task queuing and says reading is not yet confirmed, without narrating internal persistence or tool completion. The public tool parameters and existing stored Inbox format remain unchanged. Existing queued messages are not rewritten.

## Alternatives considered

**Keep all messages as future tasks.** Preserves the generic user-mail default but leaves corrective parent messages unread throughout the task they are supposed to guide.

**Steer every running Session.** Changes unrelated conversation semantics and treats mere activity as authority to amend someone else's task. The default is limited to verified direct delegated ownership.

**Use noReply to obtain steer mode.** Conflates reply requirements with scheduling and hides the intended decision in a different semantic field. An explicit internal Inbox mode is clearer.

**Add a public mode option immediately.** Makes the model choose a mode to obtain the expected parent/subagent behavior. The targeted default solves the reported case without expanding the public parameter surface; an explicit future-task option can be considered independently.

**Promote after enqueue or add a separate wake loop.** Creates a task-to-steer race or another scheduler when the persistent Inbox and existing model-loop drain already implement the required behavior. Mode is chosen before the item is committed.

**Treat a running owner or terminal-reply predicate alone as the acceptance window.** An owner remains live while a root is finishing and another task can already be queued. A reply predicate also omits unmaterialized steers and cannot serialize the final drain with admission. An explicit Runtime-only acceptance window under the existing control lock defines when a root can still consume a follow-up.

## Consequences

Parent corrections reach the next eligible model call in the same task without manual child-page actions or a new root. Already running tools and model requests finish normally, so this is not immediate interruption. Idle and unrelated targets still receive new tasks, and stopped work retains its existing controls. Parked failed steers remain visible for explicit retry but cannot block normal Rollout settlement. The internal Manager delivery result additionally exposes the admitted item to callers that need an accurate receipt; existing callers may continue ignoring it.

The real Cortex and synthetic-provider regression fails before the fix because the second model request omits the correction. It passes with exactly one root and the original tool completing normally. The same fixture covers cancellation while the Inbox write is held, completion during authorization, a follow-up arriving after the final drain with another task queued, a stopping post-job and cancellation while the control lock is held. A deterministic control-lock fixture replaces the Runtime owner while delivery waits and verifies the fresh owner governs admission. Real Inbox boundary tests retain ordinary tasks, source attribution, permission denial, role validation and lifecycle exclusions. No live Runtime restart, provider-quality claim, HTTP schema generation or persistence migration is required.

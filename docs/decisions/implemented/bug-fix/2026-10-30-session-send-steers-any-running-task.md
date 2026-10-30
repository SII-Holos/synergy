# Decision Record: Steer any session_send message the target can consume

Status: implemented

## Problem

`session_send` admitted a steer only when the sender was the target's own Cortex parent and the target was its running delegated subagent. Every other pair — two peer sessions, a coordinator and an unrelated worker, a primary-role Cortex task, an idle-wake follow-up — queued as a new task behind the target's current work. On a long task that meant hours: a coordinating agent sent four corrections of implementation-changing content into a session that had been working most of a day, each call returned `queued as a new task`, and the corrections never reached a model call while they were still actionable. The acknowledgement was honest about the mode; the mode itself was the problem.

The identity clause could not be satisfied at all between peer sessions: it required `parentID`, `cortex.parentSessionID` and `executionRole === "delegated_subagent"` to all match the sender, and a peer session has none of them (checked against two live top-level sessions with `parentID: null`, `cortex: null`). The condition read as a consumability gate but enforced a role.

## Decision

Delivery mode depends only on whether the target can consume a steer in its current root, never on the sender's relationship to it. `SessionManager.deliver` accepts an explicit `joinCurrentTask` intent, passed by `session_send`, and admits a steer when the target has:

- no pause latch, no archive stamp and no un-rollbackable rollback;
- a live runtime owner in the `running` phase that is not a `passive_input` run;
- a bound root and an open steering window (`acceptingSteer`), with an un-aborted lease;
- for a Cortex session, the durable status `running` — a lingering lease on a queued, cancelled or completed delegation is not consumable work.

Everything else stays a new task, including a target that has no root yet: a steer there would never be woken (`deliver` skips the wake without a latest root, and `SessionInbox.hasRunnableItem` reports nothing runnable), so the fallback is what makes the message run at all. Admission and the root's closing drain share the `session-control` lock, so a finishing root cannot accept a steer that a later queued task would consume.

Consumption is unchanged: the loop drains steer items into the current root before deciding whether a model call is needed, and never interrupts an in-flight tool or model request. Steer mail joins the root that is current when it is read, so a message sent to a session that is merely idle starts a new task instead of attaching to an already-answered turn.

At the root boundary, unconsumed `session_send` steers are parked through the existing failed-Inbox mechanism. This previously covered only messages from the Cortex parent; it now covers every sender, because an unconsumed steer would otherwise be attached to the next root or deleted by the abort drain, which discards steer and context items while keeping tasks. A parked item stays visible and retryable.

`session_send`'s description states the two outcomes, the no-interruption guarantee and the resend instruction for a parked steer. Internal `deliver` callers (Blueprint review notifications, `session_control` initial messages) do not pass `joinCurrentTask` and keep their new-task behavior.

This supersedes the ownership boundary of [parent follow-up steering](../../archived/bug-fix/2026-10-17-steer-active-subagent-followups.md); the acceptance window, control-lock serialization, root-boundary parking and honest result reporting introduced there remain in force.

## Alternatives considered

**Keep the ownership gate and steer only from the Cortex parent.** Preserves an authority story ("only the owner may amend the task") but leaves agent-to-agent correction unusable for peers, which in practice means the sender's only option is a message that waits for hours. The ownership claim was also not enforced anywhere else: the `identity_act` permission already authorizes the send, and the consumer never inspects the sender.

**Queue every message and rely on the Inbox control to promote it.** The UI's Send-now action flips a task to steer and works for any sender, but it needs a human on the target's page, which is exactly what an unattended long task does not have.

**Add a public `mode` parameter so the model chooses.** Moves a scheduling decision into the caller's prompt and makes the common corrective case depend on the model picking the right value; the target's own state already answers the question.

**Declare every delivery a steer.** A target with no root never wakes for a steer, and an idle target would attach the message to the last answered root instead of opening a new turn — the message would be read as an amendment of finished work rather than new work.

**Park missed steers by promoting them to tasks at the root boundary.** Avoids the manual resend, but silently rewrites the sender's declared intent and delays the message past the point where it mattered; parking keeps the miss visible without pretending the original scheduling succeeded.

## Consequences

A correction reaches a running target's next model call regardless of who sends it, and a target that cannot consume one still receives the message as a new task. Cross-session mail now shares the target's context and can change the direction of work in progress; that is the intent, and it is bounded by the target's own pause, archive and rollback state rather than by the sender's identity.

Long-running tool calls still block: a steer is consumed after the current tool or model request returns, so a multi-hour training step delays the message just as it delays any other turn. Delivery remains non-preemptive.

`finishRootSteering` no longer reads the session record, and the abort drain can no longer delete a peer's message: it is parked as failed and requires an explicit retry, which is a louder outcome than silent queuing but a recoverable one.

The predicate is tested by peer-session steering, no-root fallback, root-boundary parking, and pause/archive/rollback/stopping exclusions in `packages/local-runtime/test/tools/session-send-peer-steer.test.ts`; the earlier lifecycle scenarios keep their expectations except that unrelated senders, plain sessions and primary-role Cortex tasks now steer.

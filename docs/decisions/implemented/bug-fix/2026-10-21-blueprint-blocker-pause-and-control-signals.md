# Decision Record: Pause blocked Blueprint execution through Session control

Status: implemented

## Problem

A Blueprint executor could repeatedly explain that execution required authorization while its running Loop continued to receive ordinary continuation messages. Its completion tool only requested independent review, and using general Session control to stop the active executor attempted to acquire a second execution lease. The same lease requirement prevented replies from reaching a Session waiting for a question or permission decision.

## Decision

`blueprint_loop_stop` accepts an optional `action`: `request_review` remains the default, while `pause` records the blocker and required user input in the existing Session pause. Pause retains the running Loop, binding and progress without a review request. It is available only to interactive, non-delegated execution Sessions. Machine-owned execution keeps its existing owner-specific reconciliation; this tool does not invent a background pause or terminal outcome.

The execution callback writes the pause and returns a normal result. The existing `afterPersist` hook signals the original lease through `SessionInvoke.cancel` with pause intent, after the successful ToolPart is durable. The hook does not reacquire an execution lease, take the Session control lock, or wait for idle: concurrent user input can already hold that lock while waiting for the old lease to drain. If result processing fails first, failed tool settlement signals the already-paused original owner so same-batch questions and other cancellable waits do not prevent release. This signal is fenced by the original abort state and root identity. The invoke loop also honors the durable pause before another model turn. Same-executor pause and review requests are serialized and cannot both be accepted.

General Session abort and pending-input replies bind the target Scope and Workspace and call their existing handlers without becoming a new executor. Agent abort requests propagate the calling operation's cancellation signal through control-lock admission: a cancelled queued call must not reacquire control later and pause user input that has taken over. Exclusive operations, including compaction and worktree changes, retain lease admission. Tool cards distinguish pause from review; activity records that contain only a tool ID use a neutral Blueprint action label rather than guessing an action.

## Alternatives considered

**Add a BlueprintLoop blocked or waiting state.** Rejected because the Session pause already persists the stop and gates every automatic drive. A second lifecycle would duplicate authority and require synchronization with Continue, restart, Inbox and child completion.

**Classify blocker prose or stop after repeated replies.** Rejected because descriptions are not control requests. This could misclassify quoted or diagnostic text, adds a separate decision mechanism, and does not give the executor a reliable action.

**Use the general abort tool as the Blueprint interface.** Fixing that tool is necessary, but its self-abort interrupts its own result. Extending the existing Blueprint tool keeps pause and review discoverable together and preserves a successful pause receipt.

**Invoke full abort from the persistence hook.** Rejected because it can deadlock with concurrent user input holding the control lock while waiting for this lease. Signalling the original owner after persistence preserves the result without introducing another executor or waiting cycle.

## Consequences

Existing summary-only calls retain review behavior. No Loop status, persisted schema or HTTP API changes are required. Pausing is not approval, failure or abandonment, and does not cancel independently running descendants. Unsupported machine Sessions reject pause rather than reporting a state their owner ignores.

An executor must explicitly choose pause; prose-only blocker replies remain ordinary replies. Questions remain information requests, and their expiration never grants authorization. The deterministic regressions cover actual Session and tool execution, concurrent user takeover, conflicting actions and result-hook failure. A separate isolated real-provider acceptance checks model action selection, Runtime reopen, authorized file work and a genuine independent approval. One successful live sample establishes that path, not general model reliability.

The failure analysis and evidence boundaries are recorded in [the postmortem](../../../postmortem/0083-blueprint-blockers-could-not-pause.md).

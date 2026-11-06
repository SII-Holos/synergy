# Decision Record: Bind title recovery to its triggering execution

Status: implemented

## Problem

Session titles describe the first real user message, but title generation can fail and run again during a later task. Passing the first user envelope to `AgentCall.text` makes that historical root own every attempt. Once the first run is completed, the Rollout ledger rejects the later call before model dispatch. The default title remains despite healthy inference on the new task. A recovery test that replaces `AgentCall.text` cannot detect this admission failure.

## Decision

The existing detached `ensure-title` job captures its triggering root user at scheduling and passes that envelope explicitly through `ensureTitle` to `AgentCall.text`. The transient attribution copy omits the root's custom `system` instruction, leaving the persisted user unchanged and the title agent's instructions independent of the triggering task. Prompt construction independently selects history through the first real user message. Call evidence, cancellation and settlement therefore remain attached to the task that schedules the attempt, not the historical material being summarized.

The default-title guard, protected user rename, model-role selection, fallback model, timeout and retry policy remain unchanged. Completed Rollout runs retain their append prohibition. No persisted format, API, configuration or migration changes are required.

The recovery regression uses real temporary Scope storage, the detached job, `AgentCall`, `AgentTurn`, prompt preparation and the Rollout ledger. Only inference is substituted: the first call fails, the first run completes, and a later root schedules a successful call. Assertions require the persisted session title to recover, the first run and its calls to remain unchanged, the new call to belong to the triggering root, and prompt text to retain only the initial topic. A task-specific system marker must stay absent from prepared title instructions while remaining intact on the persisted root. This completes the ownership requirement of [title-run recovery](2026-09-19-title-run-recovery-and-small-model-call-backoff.md).

## Alternatives considered

**Permit terminal writes or reopen the first run.** Rejected because metadata recovery must not change a completed task's lifecycle or charge later execution to its immutable history.

**Use a standalone operation for every title call.** Rejected because this job has a live triggering task and already participates in its detached cancellation, evidence and settlement. Explicit operation ownership remains appropriate for historical derived work without a current owning task, not this scheduled attempt.

**Resolve the latest user when the job executes.** Rejected because queued and coalesced background work can execute after another input arrives. The scheduled root, rather than whichever root is newest, owns the call.

**Generate the title from the triggering message.** Rejected because fixing attribution must not make recovered titles describe a later follow-up instead of the conversation's original topic.

## Consequences

A temporary provider failure can recover on a later turn without mutating completed execution evidence. The internal helper requires an explicit triggering user envelope, making ownership part of the caller's responsibility. Existing untitled sessions recover when a subsequent turn schedules the job after the fixed code is loaded; the change does not backfill titles or repair network failures. Testing adds a real ledger path without external model traffic or a new fixture Runtime.

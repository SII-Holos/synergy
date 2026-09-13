# Decision Record: Detach experience encoding from turn completion

Status: implemented

## Problem

Experience encoding ran inline inside the assistant-completion hook, so a turn's rollout evidence could not close until the encoder's intent model call, embedding calls, failure retries, and reward evaluation all finished. The client rendered the final streamed answer while the session kept reporting busy: log evidence showed turns stalling tens of seconds after the answer completed, and every embedding timeout extended the stall to its full budget. The same hook ran on inbox materialization, error, and abort completion paths, so every turn shape paid the stall.

## Decision

The completion hook now only gates and schedules. Library registers a detached post-phase loop job (`experience-encode`) that runs the full encoding pipeline — encode, plugin after-hook, failure retries, reward evaluation — outside the loop lease, keyed per turn and serialized per session with a lock. A new `LoopJob.scheduleDetached` entry point lets completion paths queue a registered detached run without a loop context: the run ignores the lease abort, is bounded by its own timeout, and settles through `settleDetached` before rollout reconciliation closes the run, so model-call evidence still lands in the ledger. The idle status publishes as soon as the turn's own work finishes. Gate semantics are unchanged: non-abort assistant failures and disabled encoding never schedule. Retrieval attribution is snapshotted on the foreground path at schedule time, because the session-keyed pending entry is overwritten by the next turn's recall before a slow encode consumes it; the job's cancellation signal also aborts its queued lock wait, and cancellation propagates through the failure-retry and reward phases so a cancelled encode launches no further model calls.

## Alternatives considered

**Await the hook under a short timeout and keep encoding in the background.** Not adopted: a timeout large enough to be safe re-imposes the stall, and a short one splits the pipeline into an awaited half and an abandoned half that loses nested evidence.

**Drop encoding from the completion path and run it from a timer.** Not adopted: timers lose per-turn anchoring, and the aborted-turn repair contract still requires per-turn encoding keyed to the failed turn.

**Move the hook call sites out of the session loop.** Not adopted: the harness hook stays generic; the defect was library's synchronous pipeline behind the hook, not the hook mechanism itself.

## Consequences

Turn completion latency no longer depends on encoder model latency or embedding availability; the idle status arrives with the final answer. Encoding can now run after the user sends the next message, bounded by the job timeout and the per-session lock, so a stuck encoder delays later encodes of the same session instead of the user interface, and a cancelled queued encode abandons without consuming the newer turn's attribution. The [completion contribution decision](../../archived/bug-fix/2026-09-08-await-completion-context-contributions.md) required completion contributions to finish before rollout settlement; detached settlement now provides that guarantee for scheduled work, so that record is archived.

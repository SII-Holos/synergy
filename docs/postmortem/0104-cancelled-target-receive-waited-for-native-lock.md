# Cancelled target receive waited for its native lock

## Executive summary

Target receive accepted an abort signal for transfer I/O but acquired its per-handoff native lock without that signal. A cancelled caller remained queued behind an unrelated long receive, then could write a receiving marker before observing cancellation.

## Summary

The gap was found while connecting finite machine handoff requests to native staging. No live Runtime or real user Home was involved. Source preparation already used the cancellable native lock; target receive had retained the ordinary waiting path.

## Timeline

1. A real native lock was held while a second receive queued with an abort signal.
2. Cancelling that second receive left it waiting until the rescue barrier released the first lock; the behavioral test failed.
3. Receive changed to signal-aware acquisition and an immediate post-acquisition cancellation check. The same test rejected with the original reason before releasing the first lock, without a staging record.

## Root cause

Cancellation was implemented only inside the transfer reader. Waiting for admission preceded that reader, so no I/O cancellation check could interrupt the lock queue.

## Guardrails

`test/session/transfer-staging-cancel.test.ts` keeps the original lock held until the queued caller settles and verifies that no staging marker was published. Existing private receive and aggregate activation tests remain unchanged. See [portable epochs and streams](../decisions/implemented/architecture/2026-11-11-preserve-portable-session-epochs-and-streams.md).

## Lessons

A cancellable owner operation must carry its signal through admission as well as I/O. A check before waiting cannot replace cancellable queue ownership and a check after acquisition.

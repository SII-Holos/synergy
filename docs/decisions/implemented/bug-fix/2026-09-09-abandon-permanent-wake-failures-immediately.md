# Decision Record: Abandon session wake chains immediately on permanent failures

Status: implemented

## Problem

The wake retry chain introduced for interrupted turns retries any loop failure through the bounded backoff. A session whose git worktree directory was removed can never succeed on retry, yet every attempt re-reads session storage from disk before failing again. Startup inbox recovery re-triggers the chain for such undeliverable items on every reconnect, so one such session produced thousands of failed reads per hour — visible as a `storage.operation.error` telemetry flood, elevated server CPU, and wake-failure log noise — while the five-attempt chain always ended in the same exhausted error.

## Decision

`SessionManager`'s wake retry chain classifies failures before scheduling the next backoff attempt. Errors whose `name` is `WorktreeNotFoundError` abandon the chain immediately with a dedicated `failed permanently` error log (flagged `permanent: true`) instead of walking the delay table. The classifier matches on `error.name` because the worktree error class lives above the harness package boundary and cannot be imported here; the class already carries a stable `name` value. Transient failures keep the existing bounded backoff and `retriesExhausted` terminal log unchanged, and chain coalescing behavior is untouched.

`InvalidUrlError` deliberately stays retryable. Steer and context inbox items are drained (deleted) before materialization, so an unparseable attachment URL can surface after the poisoned item is already gone; abandoning the chain at that point would strand runnable work queued behind it. A removed worktree has no such window — it fails during worktree acquisition, before any inbox work starts, so abandoning the chain can never strand queued work.

## Alternatives considered

**Import `WorktreeNotFoundError` and use `instanceof`.** Not taken: the worktree error is owned by the local-runtime workspace package, which sits above the session layer; adding a reverse dependency to classify one failure couples the layers in the wrong direction. The error name is already a stable, string-matchable identifier.

**Classify `InvalidUrlError` as permanent too.** Not taken: unlike the worktree failure, an invalid attachment URL can be reported after the malformed inbox item has already been drained, so the retry chain still has real work to drive. Review of the drain-before-materialize ordering showed abandoning the chain in that window leaves later task items undriven until an external wake or restart.

**Delete or defer undeliverable inbox items when the chain gives up.** Not taken: inbox items are user-visible queued messages; dropping or rewriting them as a side effect of a wake retry would hide content the user explicitly queued. The existing inbox remove route and manual cleanup remain the owner of item disposal.

**Treat every repeated identical failure as permanent after N identical messages.** Not taken: content-based classification guesses intent from error text and misfires across providers and message formats; the worktree failure name covers the observed storm precisely, and the escape hatch for future classes is a one-line addition to the name set.

## Consequences

Sessions whose worktree can never be repaired stop burning retries and storage reads after the first attempt; observability dashboards regain signal because the per-retry error flood disappears. Sessions with unparseable attachments keep the bounded chain, accepting a few wasted retries in exchange for never stranding queued work behind a drained poisoned item. Undeliverable inbox items remain in place until removed through the normal inbox surface, so users keep the queued content and the startup recovery log still names the session. The name-set approach requires a deliberate update when a new permanent failure class appears — the tradeoff is documented here and the classifier sits in one place. Regression tests cover the immediate abandonment for the worktree failure, the bounded retries for `InvalidUrlError`, and a behavioral test that replays the real drain-before-materialize ordering to prove a drained invalid attachment does not strand the task queued behind it.

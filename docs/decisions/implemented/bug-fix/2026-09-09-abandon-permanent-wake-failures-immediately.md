# Decision Record: Abandon session wake chains immediately on permanent failures

Status: implemented

## Problem

The wake retry chain introduced for interrupted turns retries any loop failure through the bounded backoff. Two failure classes can never succeed on retry: a session whose git worktree directory was removed, and a queued message whose attachment URL cannot be parsed. Each retry re-reads session storage from disk before failing again, so one such session produced thousands of failed reads per hour — visible as a `storage.operation.error` telemetry flood, elevated server CPU, and wake-failure log noise — while the five-attempt chain always ended in the same exhausted error. Startup inbox recovery re-triggers the chain for these undeliverable items on every reconnect, so the waste repeats until the items are cleaned up by hand.

## Decision

`SessionManager`'s wake retry chain classifies failures before scheduling the next backoff attempt. Errors whose `name` is `WorktreeNotFoundError` or `InvalidUrlError` abandon the chain immediately with a dedicated `failed permanently` error log (flagged `permanent: true`) instead of walking the delay table. The classifier matches on `error.name` because the worktree error class lives above the harness package boundary and cannot be imported here; both classes already carry stable `name` values. Transient failures keep the existing bounded backoff and `retriesExhausted` terminal log unchanged, and chain coalescing behavior is untouched.

## Alternatives considered

**Import `WorktreeNotFoundError` and `instanceof` both classes.** Not taken: the worktree error is owned by the local-runtime workspace package, which sits above the session layer; adding a reverse dependency to classify one failure couples the layers in the wrong direction. Both error names are already stable, string-matchable identifiers.

**Delete or defer undeliverable inbox items when the chain gives up.** Not taken: inbox items are user-visible queued messages; dropping or rewriting them as a side effect of a wake retry would hide content the user explicitly queued. The existing inbox remove route and manual cleanup remain the owner of item disposal.

**Treat every repeated identical failure as permanent after N identical messages.** Not taken: content-based classification guesses intent from error text and misfires across providers and message formats; the two known-stable error names cover the observed storm precisely, and the escape hatch for future classes is a one-line addition to the name set.

## Consequences

Sessions whose worktree or attachment can never be repaired stop burning retries and storage reads after the first attempt; observability dashboards regain signal because the per-retry error flood disappears. Undeliverable inbox items remain in place until removed through the normal inbox surface, so users keep the queued content and the startup recovery log still names the session. The name-set approach requires a deliberate update when a new permanent failure class appears — the tradeoff is documented here and the classifier sits in one place. Existing wake-retry regression tests are extended with one case per permanent failure asserting the loop runs exactly once.

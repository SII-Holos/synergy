# Decision Record: Retry failed web sync scope recovery with bounded backoff

Status: implemented

## Problem

Reconnect recovery replays missed events from the Scope watermark or falls back to a full resync. Any transient failure — a replay request error, or a resync racing the initial Scope bootstrap — makes recovery return false without publishing the Scope generation and without surfacing an error. The session page deliberately skips durable snapshot sync until that generation advances, so a silently failed recovery leaves the viewed conversation stale until a manual reload, and a missed event gap stays invisible until an unrelated later event happens to trigger recovery again.

## Decision

Failed per-Scope recovery is retried by a bounded scheduler: exponential backoff from two seconds to a thirty-second cap, at most six attempts, and one pending timer per Scope. Each retry allocates a fresh recovery generation through the existing reconnect path, so a late success still publishes the per-Scope completed generation, advances the global reconnect version, and unblocks the waiting session page through the existing sync plan instead of a separate refetch mechanism. Event-gap recovery failures schedule the same retries. A successful recovery resets the attempt budget; releasing the Scope store or disposing the sync provider cancels its pending retries.

## Alternatives considered

**Retry immediately in a tight loop.** Recovery failures are usually caused by an in-flight bootstrap or a transient server error; tight retries amplify load without shortening recovery.

**Publish the Scope generation on failure.** The generation means an authoritative recovery completed; publishing on failure would admit durable snapshot refetches against unrecovered freshness state and break the monotonic-completion contract the session page relies on.

**Refetch only the viewed session on failure.** It duplicates the sync plan's dedupe and in-flight logic for one session while every other loaded session stays stale; the scheduler recovers all scopes uniformly through one path.

## Consequences

Transient recovery failures self-heal within the backoff window instead of requiring a manual reload. The worst case stays bounded: roughly ninety seconds of retry coverage per failure episode, after which the next live event gap or reconnect still triggers recovery on its own path. The scheduler adds no persisted state, no user-visible copy, and no server contract change. Regression coverage exercises the backoff curve, budget exhaustion, cancel and reset semantics, single-timer coalescing per Scope, and the recoverability guard that stops retries for released scopes.

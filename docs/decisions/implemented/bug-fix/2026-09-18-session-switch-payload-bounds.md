# Decision Record: Bound the session-switch payload to what the view renders

Status: implemented

## Problem

Switching sessions reloaded far more data than the session view renders. The initial latest page requested `limit: 200`, measured at 2.60 MB and 1.81 s TTFB for a long session in which 92.9% of the payload was tool output, while the rendered turn tree is bounded to `MAX_RENDERED_TURNS = 40` turns. Every session switch also called `GET /permission` without a filter and then discarded, client-side, every pending request belonging to another session; the route returns the pending requests of all sessions in the Scope, so a switch paid for the entire pending set to keep at most the current session's. The message-bucket LRU retained only 15 session buckets, so moving between a handful of sessions evicted timelines that were about to be viewed again and refetched a page on the way back.

## Decision

- The initial latest page uses `INITIAL_LATEST_PAGE_LIMIT = 100`, sized to the rendered turn bound rather than the full transcript. History prepends, backfill, return-to-latest, reconnect, and compaction loads keep `chunk = 200`, and any load for a session whose bucket already holds a window snapshot keeps 200, so only the first load of an unloaded session is reduced. The store cap of 500, cursor semantics, `mode` handling, `tailMissingLatest`, `pendingLatest`/`pendingLatestIds`, request-token invalidation, and the `SessionMessagePageCursorStaleError` recovery path are unchanged.
- `GET /permission` accepts an optional `sessionID` query parameter and filters server-side; without it the response is the full pending list, so the route stays backward compatible. `sync.session.sync()` passes the current `sessionID` and drops its redundant client-side session filter, keeping the `retry(...)` wrapper and the id-present guard, and preserving the existing ascending-`id` sort and the `PermissionRequest` shape.
- `MESSAGE_BUCKET_CAP` moves from 15 to 30 resident session buckets. `planBucketEviction` is unchanged, including its `Math.max(0, cap - protectedIds.size)` degradation when the protected set exceeds the cap.

## Alternatives considered

- **A separate route or a required `sessionID` parameter for pending permissions** — rejected: it would break the scope-wide snapshot the bootstrap and resync paths rely on, and a second route duplicates the same domain read for one filter.
- **Dropping the client-side permission filter entirely, trusted on the server** — rejected as an unconditional deletion: the id-present guard also protects the `reconcile(..., { key: "id" })` call, which is unrelated to session membership and is kept.
- **Making `chunk` itself 100 so every path shares one constant** — rejected: `loadMore` prepends 200-sized history pages into a 500-message cap, and shrinking the history page would roughly double the number of "Load earlier" round trips for the same history.
- **Rendering fewer turns instead of fetching fewer messages** — rejected: `MAX_RENDERED_TURNS` is a DOM bound with its own trim/re-pin behavior, and reducing it would hide conversation the user can currently scroll through rather than avoid fetching what is never rendered.
- **Evicting on a byte budget instead of a bucket count** — rejected: bucket size varies by session while the LRU input is a key list, so a byte budget would require the store to expose per-bucket sizes and would couple the pure eviction policy to store internals for no behavioral gain here.

## Consequences

An unloaded session now fetches roughly the payload its first render can consume, so switching cost tracks the rendered bound instead of transcript length; a session whose window was already loaded still refreshes with 200, so reconnect and explicit refresh keep their previous completeness. A user who immediately scrolls into older history pays one extra "Load earlier" step compared with the previous initial page, which is the trade the rendered bound implies. The permission route's response is unchanged for existing callers and only narrower for those that opt in, and the per-session pending bucket is now populated from a request that already contains only that session. Thirty resident buckets trade a bounded amount of extra memory for fewer refetches across the recently viewed working set; the eviction policy itself is untouched, so the active session remains protected and an over-large protected set still degrades to keeping only protected buckets.

Coverage: the route test asserts the filter present, absent, empty, and per-session results over `PermissionRoute`; the Web fixture test asserts an initial latest load requests `limit: 100` while history, return-to-latest, and already-loaded paths request `limit: 200`, and that the permission request carries the session ID; `planBucketEviction` keeps its existing suite, including the protected-set-larger-than-cap boundary.

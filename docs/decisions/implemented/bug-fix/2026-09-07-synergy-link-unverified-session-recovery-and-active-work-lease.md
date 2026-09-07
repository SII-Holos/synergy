# Decision Record: Link session recovery reconciles unverified caches and defers idle expiry for active work

Status: implemented

## Problem

`connect open` stalled in repeated cached-session verification timeouts. A cached session whose heartbeat could not be answered was reported `unknown`, and a fresh open was never attempted because the old remote session might still exist; recovery required a manual `connect clear` (issue #1345). The sender-side cache is deliberately not authoritative — verification timeouts must not clear it or assume the remote session is gone — but refusing every further step left the caller stuck even when the transport was healthy and the host could answer authoritatively. Separately, the host's idle lease (default 10 minutes, tracked since the last accepted request or heartbeat) expired sessions without consulting live tracked process work, so long-running remote processes could be killed while the sender was quiet or unreachable.

## Decision

`connect open` now performs bounded reconciliation when cached-session verification is inconclusive. It issues one caller-authenticated `open` against the host; the host answers authoritatively and the sender reacts statefully:

- **Same session ID returned (`reused: true`)** — the cached session is still alive; its local record is refreshed (`lastVerifiedAt`, capabilities) and kept.
- **A different session ID returned** — the cached session ended on the host; the stale record is replaced by the fresh session and the old session's dispatched results remain explicitly unknown (never replayed under the new ID).
- **`busy`** — the host belongs to another caller; the stale matching record is cleared and the other session is not disturbed.
- **`refused`** — host policy denies; the stale matching record is cleared and the refusal is surfaced.
- **Recovery open itself cannot be answered** (transport timeout/error or no client) — the cached record is preserved and the result is reported `unknown`, preserving the existing fail-closed invariant.

A stale in-flight response never clears or overwrites a concurrently replaced record; mutation is gated on the cached record still matching the session the host answered about. `verifySession` is unchanged: timeouts still never clear the cache or refresh `lastVerifiedAt`. This makes `connect clear` exceptional rather than the routine recovery step.

On the host, `SessionManager.expireIdle` defers expiry while the session owns live tracked (non-detached) process work, bounded by `ACTIVE_WORK_HOLD_MS` (2 hours) beyond the idle lease; the runtime wires this consult through `ProcessRegistry.hasActiveSessionWork`. Explicit close, kick, disable, and revocation paths are unchanged and reclaim immediately, so operator revocation semantics are preserved. Detached launches remain outside the session lifecycle.

## Alternatives considered

- **Keep the refusal and document `connect clear` as the recovery path** — rejected: it is the exact usability failure reported in #1345. Manual cache clearing is exceptional and loses the locally cached session identity even when the host could have confirmed reuse.
- **Clear the unverified cache automatically and reopen immediately** — rejected: clearing on an unverified result would discard a session that may still be active remotely, breaking the "cached record is verified cache, never authority" invariant and risking duplicate side effects under a new session.
- **Add a sender-side periodic collaboration-lease renewal (heartbeat timer)** — rejected: renewal must not be model-generated periodic tool traffic, and a fixed sender timer cannot distinguish "sender idle" from "host unreachable"; the host-side consult of actual live work is the correct signal, and demand-driven verification plus host-side lease deferral covers the reported gaps.
- **Extend the host idle lease globally (raise the default timeout)** — rejected: that would keep vanished owners' sessions alive indefinitely for all cases and weaken the bounded-owner-loss guarantee; deferral only while live tracked work exists preserves both goals.

## Consequences

`connect open` is now a working recovery step after transport loss or host restart: the caller reconciles with the host instead of clearing caches, while unknown dispatched results are still never auto-retried and another caller's session is never stolen. The bounded active-work hold prevents mid-flight process kills during quiet or unreachable periods at the cost of up to the hold window before a vanished owner's session is reclaimed by idle expiry (kick/close/revocation still reclaim immediately). The recovery open is one extra bounded request only in the previously dead-end `unknown` path. Diagnostics: the host logs `session.expired.deferred.active_work` once per deferred session and `session.expired.idle_timeout` on expiry; the sender reports which authoritative branch the recovery took or returns `unknown` with the cache preserved when the host cannot be reached.

# Decision Record: Preserve only post-stamp event writes when a Scope bootstrap snapshot is stale

Status: implemented

## Problem

The sidebar running icon intermittently failed to appear while a session was running. The Scope bootstrap snapshot (`GET /scope/bootstrap`) is an aggregated read whose server middleware stamps the response `x-synergy-seq` before the handler reads snapshot fields, making the stamp a conservative lower bound on the snapshot's freshness. The client applied `data.sessionStatus` with an unconditional `reconcile()`, gated by no version check.

When a bootstrap or resync response was still in flight (reconnect recovery, epoch reset, seq gap, `scope.runtime.disposed`, or scope-store LRU eviction followed by re-creation) and a `session.status` busy event arrived over the WebSocket first, the client applied the event — then the older snapshot's `reconcile()` deleted the busy key, because the server's `listStatuses()` read had happened before the turn started. Session status is sticky for the duration of a turn: no further status event fires until the next transition, so the wrong idle rendering persisted for the whole turn and only "self-healed" at the idle event, by which point the running state was over. The same ungated reconcile could also drop event-inserted entries from the `session` list and `cortex` collections.

A second, smaller gap compounded the race: the per-Scope store registry (`children`) is a plain object, so `peekScopeState()` reads were invisible to Solid reactivity. A sidebar row whose memo first evaluated while the store did not exist yet subscribed to nothing and never re-ran when the store was later created by an arriving event.

## Decision

Two changes, in `apps/web/src/context`:

1. **Per-key post-stamp write tracking** (`scope-snapshot-merge.ts`, `ScopeWriteTracker`). Every sequenced event write to the event-authoritative buckets — session list and Cortex — records `{epoch, seq}` per key, plus a whole-bucket marker for `cortex.tasks.updated` replacements and archive tombstones for `session.updated` with `time.archived`. Session status was tracked here too until it moved to the global session index; it now uses the same per-key discipline through `GlobalRuntimeWriteTracker` (`global-runtime-state.ts`), whose key space is flat because status, permissions, and questions are not Scope-scoped (see [eviction-independent session status](2026-09-18-eviction-independent-session-status.md)). When `applyScopeBootstrapSnapshot` applies, the tracker overlays only the keys whose last event write **postdates the response stamp** onto the snapshot; every other key reconciles to the snapshot as-is, **including its deletions**. Epoch changes reset the tracker, so a reset-resync snapshot is fully authoritative.
2. **Reactive store registry** (`global-sync.tsx`). `peekScopeState()` observes a registry-version signal bumped on store creation and eviction, so consumers that first saw `undefined` re-run when the store appears.

The first revision of this change gated on the scope-wide watermark and merged with "local event state wins" semantics. A review pass (PR #1394) identified the flaw: in the reset-resync path a session whose idle event was missed keeps a stale local `busy`, and any unrelated post-stamp event would then keep that stale status alive indefinitely because the scope-wide merge preserved _every_ local entry. The per-key scheme restricts event authority to keys the events demonstrably wrote after the snapshot was read, so fail-open resync still converges to server state while genuinely newer writes survive.

## Alternatives considered

- **Scope-wide "snapshot is behind ⇒ local wins" merge.** The first implementation; rejected by review because it cannot distinguish a post-stamp write (event is newer) from pre-stamp state left stale by a missed event (snapshot is newer), which resurrects stale rows indefinitely in the reset-resync path.
- **Reject the whole stale snapshot instead of merging.** The snapshot is also the source of provider/agent/config/path and gap-filling sessions the events never carried; discarding it entirely would trade a stuck icon for stale configuration whenever the race hits.
- **Extend `SyncResourceFreshness` to cover session status/list/Cortex.** That machinery is keyed by `(scopeKey, sessionID, resource)` and models per-session resources; session status and list are Scope-level collections without session granularity, and the response stamp already carries exactly the ordering fact the per-key comparison needs.
- **Fix only the reactive registry, or only the snapshot race.** Each fix addresses an independent failure mode — the registry gap produces a stuck icon without any snapshot in flight, and the snapshot race produces one even with a live subscription — so both are required.

## Consequences

A busy status applied from an event survives a bootstrap response read before the turn started, so the sidebar keeps the running icon through reconnect resyncs that overlap turn starts; the same holds for event-inserted sessions and Cortex tasks. Conversely, state left stale by a missed event (an idle that never arrived, an archived session) converges to the authoritative snapshot on the next resync instead of surviving indefinitely. Post-stamp archive tombstones are honored — an older snapshot read cannot resurrect a session archived after the stamp. The tracker is per-scope, keyed by session/task id, cleared on epoch change and scope release, so memory is bounded by the number of tracked ids. The registry signal adds one Solid dependency to `peekScopeState()` consumers; they re-run on store creation/eviction, bounded by the eight-store LRU. Optimistic unsequenced writes to the three buckets are not tracked — the only such write is the workspace-transition leaf on the session row, which the canonical `session.updated` and the next non-stale snapshot converge anyway.

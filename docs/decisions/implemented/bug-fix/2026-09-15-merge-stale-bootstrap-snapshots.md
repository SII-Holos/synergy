# Decision Record: Merge stale Scope bootstrap snapshots instead of reconciling event-authoritative buckets

Status: implemented

## Problem

The sidebar running icon intermittently failed to appear while a session was running. The Scope bootstrap snapshot (`GET /scope/bootstrap`) is an aggregated read whose server handler stamps the response `x-synergy-seq` before reading snapshot fields, making it a conservative lower bound on the snapshot's freshness. The client applied `data.sessionStatus` with an unconditional `reconcile()`, gated by no version or watermark check.

When a bootstrap or resync response was still in flight (reconnect recovery, epoch reset, seq gap, `scope.runtime.disposed`, or scope-store LRU eviction followed by re-creation) and a `session.status` busy event arrived over the WebSocket first, the client applied the event — then the older snapshot's `reconcile()` deleted the busy key, because the server's `listStatuses()` read had happened before the turn started and contained no entry for the session. Session status is sticky for the duration of a turn: no further `session.status` event fires until the next transition, so the wrong idle rendering persisted for the whole turn and only "self-healed" at the idle event, by which point the running state was over. The same ungated reconcile could also drop event-inserted entries from the `session` list and `cortex` collections.

A second, smaller gap compounded the race: the per-Scope store registry (`children`) is a plain object, so `peekScopeState()` reads were invisible to Solid reactivity. A sidebar row whose memo first evaluated while the store did not exist yet subscribed to nothing and never re-ran when the store was later created by an arriving event — the icon only updated after an unrelated nav-entry replacement.

## Decision

`applyScopeBootstrapSnapshot` compares the response version (`x-synergy-epoch`/`x-synergy-seq`) against the Scope's applied event watermark. When the response shares the watermark's epoch but trails its seq, the snapshot predates already-applied events, so the event-authoritative buckets — `session_status`, `session`, and `cortex` — merge instead of reconciling: local event state wins and the snapshot only fills gaps (`scope-snapshot-merge.ts`). Session totals take the larger of the server total and the merged list length. Unversioned responses and same-or-newer seq keep the plain reconcile path, so ordinary bootstraps and fresh scopes are unchanged. The per-Scope store registry is now reactive: `peekScopeState()` observes a registry-version signal bumped on store creation and eviction, so consumers that first saw `undefined` re-run when the store appears or disappears.

## Alternatives considered

- **Reject the whole stale snapshot instead of merging.** The snapshot is also the source of provider/agent/config/path and gap-filling sessions that the events never carried; discarding it entirely would lose those fields whenever the race hits, trading a stuck icon for stale configuration.
- **Skip only the affected buckets on a stale response.** Simpler than merging, but a long-lived scope whose events regularly outrun slow bootstrap responses would keep accumulating dead sessions and statuses; deletion semantics (archived sessions, idle statuses) still need the snapshot when it is genuinely current, and never applying newer server deletions leaks state until the next successful resync.
- **Extend `SyncResourceFreshness` to cover session status/list/Cortex.** The resource-freshness machinery is keyed by `(scopeKey, sessionID, resource)` and models per-session resources; session status and list are Scope-level collections without session granularity, and threading them through would grow the class for one snapshot site while the watermark already carries exactly the ordering fact needed.
- **Fix only the reactive registry, or only the snapshot race.** Each fix addresses an independent failure mode — the registry gap produces a stuck icon without any snapshot in flight, and the snapshot race produces one even with a live subscription — so both are required for the symptom as reported.

## Consequences

A busy status applied from an event survives a bootstrap response that was read before the turn started, so the sidebar keeps the running icon through reconnect resyncs that overlap turn starts; the same holds for event-inserted sessions and Cortex tasks. Merging trades a strict "snapshot replaces" semantics for union semantics in exactly the stale-snapshot case, which can briefly retain a session whose archive event was itself superseded by an older snapshot read — the next non-stale bootstrap or the archive event's own nav projection still removes it. The registry signal adds one Solid dependency to `peekScopeState()` consumers; they re-run on store creation/eviction, which is bounded by the eight-store LRU and only fires on transitions that previously left consumers stale.

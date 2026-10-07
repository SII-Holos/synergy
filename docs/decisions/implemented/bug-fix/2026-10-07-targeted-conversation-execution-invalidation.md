# Decision Record: Targeted conversation execution invalidation

Status: implemented

## Problem

The conversation's execution query owner reads the latest 64 transcript roots. A scoped `session.execution.updated` lifecycle event carries one root identity, but invalidating the whole resource re-reads unrelated roots. Refetching during a pending query aborts that query without retaining the affected root's newer invalidation. This is lifecycle fanout, not a per-token event or a measured production throughput claim.

## Decision

`SessionConversation` retains a local request baseline, a keyed execution-state store, per-root versions and a dirty-root set. The generated `session.turnExecution` method initially reads the latest 64 roots. Membership changes dirty only added roots and remove evicted cache entries. A same-turn microtask coalesces invalidations, and one request per identity runs at a time. Events received during a request stay queued without aborting it; only roots whose versions still match may accept the response. Completion drains independently dirtied roots once, merging partial responses by root rather than replacing the window.

Each asynchronous success or failure settles its still-current root writes inside one Solid `batch`, retaining targeted `reconcile` for accepted states. The real virtual conversation's process-state memo subscribes to the root collection, so separate per-root store transactions would repeat a whole-window projection for each changed root. Synchronous membership pruning stays inside its existing effect update cycle.

Connection, Scope, client and Session changes advance an identity epoch and abort the obsolete request. The epoch prevents an A-to-B-to-A response from regaining ownership; monotonically assigned root versions likewise fence eviction and re-admission. Preparation readiness and canonical Session presence retain the current admission gates. Closing admission aborts and fences pending work and clears cached states; reopening reads a fresh latest-64 baseline. Disposal cancels pending work. Permission transitions and GlobalSync's existing `reconnectVersion` accessor conservatively dirty the retained window. Status/terminal-message revision changes retain their fallback query for the latest loaded root only. No server route, schema or synthetic reconnect event is added.

A failure clears only still-current requested root states so the existing message-derived presentation can take over. The failed batch never dirties itself. An invalidation received in flight may trigger one follow-up request, and later lifecycle, permission or reconnect invalidations can recover affected roots.

Canonical message IDs remain request and cache keys. The non-virtual row reads execution state through its current root ID, not the optimistic display alias that retains its DOM identity. The existing first-send handoff effect still requires canonical execution evidence and captured summary/body versions before releasing the preparation lease. Part arrivals, motion and alias ownership remain unchanged.

The behavioral regression extends the existing real `SessionConversation` retention fixture, using real Solid ownership, the current transition and arrival state, and the generated SDK with a held transport boundary. It observes request bodies, identity headers, abort signals and rendered execution states; the process-only DOM fixture does not own these requests. Six owner scenarios cover batching, in-flight invalidation, membership, identity, conservative recovery and bounded failure. Readiness close/reopen and canonical execution through a first-send display alias additionally cover current admission and handoff. Existing retention, virtualization and Suspense regressions remain in the same suite.

Two response scenarios mount the actual `VirtualConversationRows` with 70 timeline roots and hold the generated SDK's 64-root request. Fixture-owned submission and Part-page callbacks count process-state and row-projection work for an unmounted middle root, excluding mounted-row reads. Success and failure each commit one process-state pass and one projection pass, alongside the visible requested root's execution state and natural request drainage. These scenarios close the whole-window recomputation gap left by non-virtual request-owner tests without source-text assertions or production instrumentation.

## Alternatives considered

**Whole-window resource refetch.** It discards the root identity carried by the lifecycle event and repeats unrelated reads; abort-on-refetch also loses the opportunity to merge unaffected root results.

**Independent requests for every event.** It permits duplicate same-turn requests and stale out-of-order writes. Dirty-root batching and singleflight preserve event intent without parallel queries for the same owner.

**A global execution cache or new recovery event.** Neither is necessary for this component-owned window. Existing SDK identity and GlobalSync reconnect generations provide the required recovery signals without broad infrastructure changes.

## Consequences

Combined regressions retain Session switching display admission and execution invalidation in the same mounted conversation. Their fixture shares the Session signal across canonical data and execution, and can independently hold current body hydration while a target changes.

A matching single-root lifecycle invalidation submits one root instead of 64; multiple same-turn roots share one request. Unaffected accepted states survive partial responses and refresh failures. Initial and conservative permission/reconnect reads still query up to 64 roots, but all accepted writes or failure clears from one response publish coherently. Per-root fences can require a second query when lifecycle state changes in flight; recovery stops when failures settle without another invalidation. The fixture establishes owner-level correctness, request fanout and virtual projection work, not production latency or per-token savings.

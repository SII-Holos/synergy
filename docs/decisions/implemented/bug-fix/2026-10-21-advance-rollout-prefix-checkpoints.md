# Decision Record: Advance Rollout presentation during active recording

Status: implemented

## Problem

Presentation checkpoint publication requires an unchanged journal head throughout reconstruction. Active recording can append during every read, preventing checkpoint progress and making later reads replay the same growing history. Context history also requests the complete execution snapshot before selecting a page, although it needs only current run and model-call metadata.

## Decision

`RolloutSnapshot.current()` captures a committed revision, its boundary record version and any reusable checkpoint in one storage snapshot. Reconstruction reads only through that captured revision. Publication checks that the same boundary still exists and that the current head includes it, then stores the validated prefix even if newer events have committed. A valid newer checkpoint wins over an older reader finishing later. Boundary record versions fence owner deletion and recreation without treating ordinary appends as conflicts.

`RolloutSnapshot.modelCalls()` reads current run and call projections in one storage snapshot after owner preparation. Context history and individual context requests consume this narrower public query with the existing retained usage and message headers. They preserve request ordering, run filters, context attribution and cursor identity without reading journal events, tool/process projections or artifact bodies. Header metadata is still collected and sorted across the selected Session to preserve total counts and global request/round ordinals; this change does not claim constant work per page.

Strict historical replay, recovery and archives retain their complete evidence checks. The persisted checkpoint format and HTTP schemas remain unchanged, so existing Homes need no data migration.

## Alternatives considered

**Keep requiring an unchanged head.** This preserves a simple publication check but can indefinitely prevent progress under streaming writes. The immutable captured boundary provides the necessary identity check without blocking on unrelated appends.

**Only advance checkpoints and keep context queries on full snapshots.** Warm reads improve, but the first context page still pays for unrelated historical execution evidence and stale checkpoints. Current run and call projections already commit atomically with journal evidence and provide the metadata this presentation needs.

**Add a separate persisted context paging index.** This could reduce header work further but adds historical backfill, transfer and deletion responsibilities. The existing projection removes journal replay without introducing another persisted format.

## Consequences

Active Sessions can advance reusable checkpoints and subsequent reads replay only the remaining tail. Context queries avoid full history reconstruction even with a cold presentation cache. Query cost still scales with retained run, call, usage and message headers; integrity audits remain more expensive by design.

Regression tests use isolated storage and deterministic interleavings to verify continuous appends, monotonic checkpoint publication, owner recreation, restart reuse and missing evidence. Context route tests verify stable cursors across new appends and forbid complete snapshot reads; projection tests cross a run-header batch and retain current estimates without reading unrelated tool evidence.

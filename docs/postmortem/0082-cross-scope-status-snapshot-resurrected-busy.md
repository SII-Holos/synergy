# Cross-Scope status snapshot restored completed Sessions as busy

## Executive summary

A completed Session retained its sidebar running icon because a delayed Runtime-wide status snapshot could overwrite a project idle event already applied by the frontend. The snapshot and event used unrelated Scope clocks. Snapshot coverage must match the ordering evidence used to merge it.

## Summary

The reported Session's execution finished and released its runtime before the screenshot. Read-only inspection found idle backend status, settled tools and no child Sessions or Cortex tasks. Sidebar classification correctly rendered its supplied runtime index; that index could be made stale by the global status response.

## Timeline

- The reported terminal processor completed at 11:41:23 and its runtime was unregistered at 11:41:24. The screenshot at 11:41:45 still showed running state.
- A separate Home, explicit alternate backend and frontend ports, and local synthetic model provider isolated reproduction from the active product instance.
- A normal task's real WebSocket feed published idle, followed by metadata without `working`; this sample did not reproduce a busy metadata fallback after idle.
- Chromium then held an actual global status response containing busy until the project idle event arrived. Releasing the response restored `Running session` in the real sidebar while the backend remained idle and the console had no errors.
- The GlobalSync regression failed with a completed project Session restored as busy. After the ordering fix, that regression passed and the same real browser probe reported idle backend status, a resting sidebar icon and no console errors.

The original frontend network trace was unavailable. Controlled response delay demonstrates a sufficient production mechanism and the fix's effect; it does not reconstruct the original HTTP timing.

## Root cause

Server request middleware supplies Home context for `/global/session/status` and stamps that Scope's epoch/sequence before the handler reads statuses across Scopes. Bus sequencing is per Scope runtime. The frontend passed this global response to a tracker whose epoch field represented only the most recently written Scope. Epoch mismatch returned no overlay, so `reconcile()` restored the older busy value even after a real idle deletion. An unrelated Scope or Cortex event could also clear the status write map before a Scope snapshot applied.

Existing tests used the same synthetic epoch for unrelated Scopes. They verified post-stamp merging but could not expose the invalid cross-Scope clock comparison. Terminal replies and healthy event delivery were insufficient checks because this failure occurred after idle was delivered successfully.

## Guardrails

- [GlobalSync provider regression](../../apps/web/test/context/global-sync-snapshot-event-race.dom.test.ts) uses distinct epochs, a delayed global response, concurrent work and obsolete Runtime responses.
- [Status tracker tests](../../apps/web/test/context/global-runtime-state.test.ts) cover request-period deletion preservation, stale-state convergence, derived pauses and foreign events between a Scope snapshot and its idle transition.
- [Frontend synchronization](../architecture/frontend-data-sync.md) defines the different global and Scope snapshot ordering rules.
- [The decision](../decisions/implemented/bug-fix/2026-10-21-cross-scope-session-status-snapshots.md) records the choice and alternatives; the [frontend workflow](../../.synergy/skill/develop-frontend/references/state-and-recovery.md) requires a real delayed-response check for this class of failure.

## Lessons

A response header identifies one sequencing domain, not every entity carried by its body. Cross-Scope fixtures must use independent clocks. Verify both event application and later HTTP reconciliation, and distinguish transport loss from successfully delivered terminal state that is overwritten afterward.

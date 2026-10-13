# Optional owner startup and native panel reset

## Executive summary

Optional-component extraction introduced startup scans of complete Session subtrees and destroyed native panels whenever capabilities became temporarily unknown. Small migration fixtures and tests limited to plugin disposal missed both failures. Startup work and native presentation identity need separate invariants from capability availability.

## Summary

A copied large retained Home failed before serving health requests: the Blueprint owner migration enumerated all Session descendants, and the SQLite worker exhausted its liveness ceiling. Light Loop and Lattice used the same traversal. In the workbench, a WebSocket disconnect reset the capability snapshot; filtered tabs disappeared and mounted native panels were retired before the replacement snapshot arrived.

## Timeline

Independent integration acceptance first reproduced the native panel remount with a rendered browser test. A full retained-data startup then failed after about one minute in the Blueprint owner migration. Populated runtime tests reproduced the startup traversal and demonstrated that completed global receipts must not prevent deferred owner conversion. The corrected startup reached healthy reader, writer and model readiness; browser fixtures retained native editor DOM and selection across revalidation.

## Root cause

Extracted owner migrations used global startup execution and listed every key below Sessions before filtering to metadata. Filtering after enumeration did not bound SQL work. Panel residency treated removal from the visible projection as resource deletion, conflating unknown capabilities with a confirmed absent feature. Plugin disposal tests correctly required cancellation but did not exercise native editor continuity.

## Guardrails added

[Runtime composition tests](../../packages/presets/test/composition/owner-migration-startup.test.ts) observe real storage calls against populated history, pending and completed receipts, and canonical/display agreement. [Light Loop tests](../../packages/light-loop/test/session/owner-migration.test.ts) inject a publication failure and require atomic rollback and retry. [Rendered residency tests](../../apps/web/test/context/workbench/residency-capabilities.dom.test.ts) cover native identity, selection, confirmed removal, closure during revalidation and plugin cancellation. The [decision record](../decisions/implemented/bug-fix/2026-10-13-optional-owner-admission-and-residency.md) records the tradeoffs; persistence and frontend skills include the new verification cases.

## Lessons

An optional owner becoming available must obey the same startup work limits as core code. A visible navigation projection is not the authority for destroying a retained native resource. Test both unknown and absent capabilities with real mounted state.

# Interactive reads scanned historical state

## Executive summary

A large existing home exposed coupled latency in Session navigation, first-message processing and Library opening. Small fixtures verified final values but missed repeated historical discovery and page-level suspension. The fixes keep navigation on cached or indexed reads and test timeout convergence independently of normal completion.

## Summary

Library opening awaited a global usage refresh even though a persisted snapshot already existed. Its enclosing Suspense also hid navigation. Leaving the last Session view discarded Scope state, including sidebar status. Startup discovery repeatedly enumerated historical sessions, inboxes and continuation directories before processing a newly queued input. A stalled handoff stopped observing eventual materialization.

## Timeline

- Interactive inspection reproduced slow switching, a prolonged Library spinner and missing sidebar status after leaving a Session view.
- Request inspection separated the fast Library collection request from the pending global usage computation.
- Code tracing located last-lease eviction, serial historical recovery discovery and the loading-only handoff observer.
- Regression fixtures reproduced these contracts before their fixes. A metric window exceeding 50,000 samples separately reproduced missing early buckets.
- Restart verification exposed serial journal replay during saved-work recovery. A bounded-read regression reproduced one storage read per historical event and retained missing-event and sequence checks across batch boundaries.

## Root cause

Correctness tests mainly started from small homes and awaited final responses. They did not distinguish a snapshot read from recomputation or assert recovery discovery without walking empty owners. The lifecycle retention test deliberately asserted immediate eviction, without checking global-panel navigation. Handoff tests proved the decision helper recognized a late root, while the page observer stopped calling it after error. Telemetry terminated the attempt at its deadline, obscuring actual slow completions. Historical encoding retries also reused source-root execution ownership after termination.

## Guardrails added

- [Scope retention tests](../../apps/web/test/context/scope-retention.test.ts) cover leaving, revisiting and bounded eviction.
- [Statistics tests](../../packages/workbench/test/stats/engine.test.ts) distinguish cached reads from refresh.
- [Recovery discovery](../../packages/harness/test/session/interactive-discovery.test.ts) rejects per-history traversal; [continuation tests](../../packages/harness/test/session/rollout-continuation.test.ts) cover upgrade and repeated execution.
- [Journal replay tests](../../packages/harness/test/session/rollout-journal.test.ts) bound reads for a multi-batch history while preserving revision, order and integrity failures.
- [Navigation timing](../../apps/web/test/utils/perf.test.ts) and [handoff decisions](../../apps/web/test/components/session/session-transition-handoff.test.ts) cover completion after a deadline.
- [Performance store tests](../../packages/workbench/test/performance/store.test.ts) retain exact counts and early buckets beyond the old cap.
- [Agent call tests](../../packages/harness/test/agent/call.test.ts) execute an independent derived call under a terminal source context.

## Lessons

A loading indicator is not an isolation boundary. Test cached reads while historical evidence changes, recovery discovery with many empty owners, and late convergence after visible errors. Keep the current contracts in the [decision record](../decisions/implemented/bug-fix/2026-09-18-interactive-read-isolation.md).

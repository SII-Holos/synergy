# Shared export replayed unchanged history through writers

## Executive summary

A real capacity fixture completed its 10,000-message native history but could not produce its first synchronization batch within the existing export window. Replaying unchanged safe events and rebuilding the retained baseline repeatedly entered durable writer transactions. The native chronology reader also opened a writer for a prepared read.

## Summary

The joint fixture uses ten clients, three independently enrolled Runtime processes, one hundred Sessions and a chunked attachment. Its native producer finished the long history in 202.5 seconds. Sharing then failed to reach the first actual batch within 240 seconds; the long Runtime was observed near 1.06 GiB RSS. These observations establish the failed workload, not a total-memory bound or a product quota.

## Timeline

The complete attempt failed after 449.6 seconds. A smaller original-owner regression preserved 129 messages and their parts but observed one writer during the prepared native read. A real enrolled exporter with 512 messages observed 3,079 source writer callbacks before its first batch, against a work-window maximum of seventeen. The native correction and its error, deletion, legacy-ID and cursor neighbors passed. The 512-message exporter and repeated-share regression passed with both writer windows bounded; this is not a wall-clock comparison against the earlier first-generation failure. The corrected readers and generation windows did not close the full workload: its next actual attempt still missed the first batch after all native production completed. The producer-to-export regression then reproduced a first-batch timeout with 565 total source writers but only 25 retained projections. After separating native persistence from exporter writers and batching the original native selectors, the actual 512-message first batch and repeated share passed: eleven exporter writer transactions reached each first batch. The unchanged full joint workload still requires its own actual receipt before closure.

## Root cause

Safe-event comparison happened inside a writer even when the original draft or projection was identical. Generation replay repeated Session projection work per message and part, then recreated every retained draft in a separate writer. Its durable outbox retained unacknowledged data correctly, but bounded network payloads did not bound this repeated native work. A prepared chronology snapshot also used the owning repair transaction despite already having complete current coverage. Per-message callbacks and per-Part workers retained complete payloads and serialized the live producer backlog before generation preparation; the earlier small generation regression waited for that backlog to settle and therefore did not measure it.

The Service had a second replay path: signed batches already maintained their projections atomically, but a new share lacked the existing preparation coverage fact. Concurrent first-screen requests replayed an already indexed history. A real signed Runtime with 1,025 events and ten authenticated clients reproduced eighty-seven canonical replay pages before the correction and zero afterward; a retained generation without the fact still rebuilt from its canonical events. The complete common workload retains its separate acceptance requirement.

## Guardrails

Live native observations use one Session worker over original selectors, prepare payloads outside SQL and publish bounded windows through the same native outbox owner. Only unsequenced same-identity updates coalesce. Generation replay checks the original Runtime, Store, connection and current native Session/root/Scope/binding before reusing safe events. Changed values recheck that binding in their write transaction. Retained projections, drafts and order selectors use 128-record windows and retain the original outbox, acknowledgement, generation, artifact-pin and cleanup owners. Prepared native reads capture chronology IDs in one readonly snapshot and preserve existing header hydration, missing-record and storage-error behavior; inconsistent coverage still uses the owning repair path. Captured ID metadata remains proportional to history size, and pending native-selector and Session-tail collections are not represented as a total-RSS bound.

- [x] Machine check: `packages/harness/test/session/message-stream-work.test.ts`, `message-read-errors.test.ts`, `message-stream-memory.test.ts` and `message-page.test.ts` verify the actual prepared reader and affected history semantics.
- [x] Machine check: `packages/organization-runtime/test/sync-generation-window.test.ts` verifies real first-generation and repeated-share export, complete IDs and durable backlog drainage.
- [x] Machine check: `packages/organization-runtime/test/sync-live-window.test.ts` starts actual Store observation before native production and checks current first-generation and repeated-share export, complete IDs and backlog drainage without pre-waiting for live projections. Canonical native persistence remains a separate diagnostic from exporter writer work.
- [x] Machine check: `packages/organization/test/shared-projection-coverage.test.ts` verifies no replay for a genuinely covered fresh generation, original missing-coverage reconstruction, fixed watermarks and share revocation.
- [ ] Machine check: `packages/organization-runtime/test/capacity-sync.test.ts` records the complete ten-client, three-Runtime, hundred-Session workload, attachment integrity, backlog and process peak measurements.

## Lessons

Bound durable work separately from wire payloads, and measure it through the actual native writer and transport owners. Preserve captured history membership and completion evidence while removing repeated work. Small owner regressions explain the failure; they do not replace the complete capacity receipt.

# Historical pages exhausted authoritative storage readers

## Executive summary

Managed Desktop could reach a shell while historical conversation requests stalled or failed with storage-busy errors. Limited logical queries still scanned the authoritative namespace, and opening a conversation also started an unrequested complete execution aggregate. Startup-only tests missed work initiated after readiness.

## Summary

A large installed-data reproduction exposed minute-long prefix queries, reader admission failures and slow Session changes. Small fixtures and page-length assertions could pass while the physical query plan remained proportional to unrelated history.

## Timeline

On 2026-10-10, an isolated consistent data copy reproduced the managed startup and conversation failures. Query-plan inspection identified namespace-wide prefix filtering. Further rendered-UI checks exposed repeated header preparation and automatic complete execution reads after navigation. Work was corrected at each owning layer and rechecked against the same copied history.

## Root cause

A serialized prefix predicate plus SQL LIMIT bounded output, not scanned records. Batch body hydration repeatedly prepared neighboring display windows. The execution provider automatically requested full task summaries on selection, focus and reconnect; old tasks without a current checkpoint could replay their complete evidence journal. Pause and Light Loop startup reconciliation independently inspected unrelated historical owners; pause discovery hydrated complete message bodies. Desktop child-exit errors could also omit an already observed failed startup stage.

## Guardrails added

[Storage traversal tests](../../packages/harness/test/storage/traversal.test.ts) verify exact-key plans and paged live-child semantics. [Display-page tests](../../packages/harness/test/session/display-page.test.ts) bound canonical message reads by requested messages. [Execution summary tests](../../apps/web/test/context/execution-summary.test.ts) cover demand, navigation, cancellation and late replies. [Desktop tests](../../apps/desktop/test/server-manager.test.ts) retain failure stages across child-exit races. [Full-runtime experience tests](../../packages/presets/test/server/history-experience.test.ts) include thousands of untouched owners, old-page access and new-session admission. [Pause recovery tests](../../packages/harness/test/session/pause-recovery.test.ts) cover lazy enrollment, transaction rollback, newer-write races and compaction boundaries. The [implemented decision](../decisions/implemented/bug-fix/2026-10-10-bound-interactive-history-storage-work.md) defines ownership and tradeoffs.

## Lessons

Measure readiness through readable historical content and an interactive composer. Inspect physical storage work, including work started after first paint. Use deterministic work bounds as the main CI safeguard and generous timing guards for shared runners; keep installed-data latency measurements separate from CI thresholds.

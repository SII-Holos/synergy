# Concurrent owner preparation blocked message publication

## Summary

A cold execution load with 20 root tasks and 80 children exhausted storage admission deadlines and stopped making progress. The same load could finish when warmed by page reads or when diagnostic wrappers changed scheduling. The waiting task was publishing an input message while an outside historical-preparation operation needed the writer held by that publication.

## Root cause

Owner preparation reused one in-flight Promise per owner across all callers. A transaction-local message read joined the same Promise as external reads. Holding the serialized writer while awaiting that Promise inverted preparation and business admission. A 30-second queue timeout eventually interrupted part of the work, leaving task failures; raising concurrency or waiting longer could not resolve the cycle.

## Verification

A barrier test reproduces the wait even for an owner whose receipts are already current: an outside preparation remains pending while a business writer reads that owner. Before the fix, the writer needs the test's rescue release; afterward it reads its transaction-local receipts and completes independently. Further tests reject missing preparation inside both writer and reader transactions without running the migration. Input rollback, first queued task protection and restoration remain covered.

The cold full-execution fixture completed all 20 roots, 80 children and 100 tool reads after the fix, with no failures and the existing Worker and Cortex limits. This controlled-provider result verifies actual execution and storage behavior, not real-provider throughput. Real-data and real-model acceptance are separate checks.

## Prevention

The [preparation admission decision](../decisions/implemented/bug-fix/2026-10-17-owner-preparation-transaction-admission.md) defines the receipt check and explicit preparation boundary. Never use a successful prewarmed run as the sole evidence for concurrent startup. Preserve deterministic barriers alongside the complete execution fixture.

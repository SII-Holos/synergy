# Portable writer retained mutable inputs

## Executive summary

A writer could finish after its original cancellation was removed from the input object, and entry metadata could change while storage was pending. Capturing the original ports and JSON metadata before asynchronous work fixes both cases. Cancelled requests must also be rejected before starting a producer.

## Summary

Canonical stream fixtures reproduced an accepted object write whose caller signal was aborted and cleared before completion. Independent review also held a write or chunk-page operation, changed nested metadata, and observed those later values in the persisted entry. Two further fixtures observed a producer start despite a pre-cancelled signal. All tests used private temporary data and did not use a user Home.

## Timeline

1. Removing the original signal during a held object write returned a complete root instead of the original cancellation.
2. Capturing the original writer ports fixed that path while sharing the existing metadata page writers with reference composition.
3. Independent review showed that the JSON predicate validates nested values without cloning them. Both content writing and reference composition persisted metadata changed during their awaited writes.
4. Pre-cancelled invocations started one producer before rejecting.
5. JSON snapshots before chunk work and pre-producer admission checks made all four additional counterexamples pass.

## Root cause

Asynchronous storage separated entry selection from metadata serialization. Nested schema values remained references to the caller, and cancellation was checked after producer admission or through a mutable input object.

## Guardrails

- [x] Machine check: `packages/harness/test/session/transfer-stream-reference.test.ts` verifies the original signal across an accepted write, nested metadata snapshots in both modes, and zero producer starts after pre-cancellation.
- [x] Machine check: the same suite verifies metadata-only composition and strict chunk totals, followed by normal complete-content verification.

See the [decision](../decisions/implemented/bug-fix/2026-11-12-snapshot-portable-writers-before-storage.md) for writer and content-retention ownership.

## Lessons

Validation does not imply value ownership. Snapshot the exact persisted meaning before awaiting work, and check admission before invoking a producer.

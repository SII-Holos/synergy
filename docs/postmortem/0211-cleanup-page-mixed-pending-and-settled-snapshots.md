# Cleanup paging mixed pending and settled snapshots

## Executive summary

A native cleanup reader could enumerate a pending marker, then read its entry after a legitimate terminal settlement committed. It classified that mixed view as index corruption. Read an index page and its canonical records within the same owning read-only snapshot.

## Summary

The Hosted always cross-Project/Home case completed its native work but failed while waiting for resource release with `PROTOCOL_MISMATCH: Native cleanup pending index is inconsistent`. The original CI log did not retain the exact reader/writer interleaving. A controlled regression reproduced the same rejection by committing a real terminal settlement between the original marker query and entry read.

## Timeline

- The original CI case failed after 13.960 seconds with completed native work, no running manager or background work, and release still pending.
- Source tracing found separate schema, marker and entry read snapshots. The writer already settled the entry and removed both pending indexes atomically.
- Both Runtime-wide and exact-root controls rejected a real concurrent settlement on original production.
- One original read-only snapshot per page passed both controls, the original Hosted case and the complete release-observer file: 13 cases and 143 assertions. A deliberately retained corrupt marker still produced the exact original protocol error.

## Root cause

Atomic writes do not make multiple reader statements atomic. The pending marker was valid when selected, and the settled entry was valid when read later. Combining them produced an invalid apparent relationship without any corrupt write.

The page now uses the existing Store snapshot, retaining its Runtime, Store and artifact ownership checks, bounded limits, cursors and strict index validation. It does not add a writer transaction, skip missing entries, cache authority or reinterpret malformed markers as concurrent cleanup.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/execution-leases.test.ts` — original marker query held across an actual terminal settlement COMMIT in Runtime and root partitions; fresh paging and genuinely inconsistent retained markers.
- [x] Machine check: `packages/organization-runtime/test/hosted-permission-always.test.ts` — real Hosted rule scope and native release across Project and Home boundaries.
- [x] Machine check: `packages/organization-runtime/test/renewed-release-observer.test.ts` — exact generations, dispatch horizons, cancellation and observer drainage.
- The [generation ownership decision](../decisions/implemented/architecture/2026-11-12-close-handoff-resource-generations-without-input-replay.md) defines consistent pending-page reads.

## Lessons

Preserve strict corruption detection by fixing the read boundary. Suppressing the error or ignoring missing rows would hide real corruption while leaving the inconsistent observation unresolved.

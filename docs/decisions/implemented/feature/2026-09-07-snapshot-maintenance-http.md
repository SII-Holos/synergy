# Decision Record: Snapshot maintenance through HTTP and the Storage panel

Status: implemented

## Problem

Shared file snapshot storage ([shared-file-snapshot-storage](../architecture/2026-09-07-shared-file-snapshot-storage.md)) ships `migrate` and `compact` as CLI-only maintenance commands (`synergy data snapshots migrate|compact`), and [snapshot storage usage and orphan cleanup](2026-09-07-snapshot-storage-usage-and-cleanup.md) deliberately exposed only the safe read/reclaim paths to the Web (`usage`, `clean`). The result was an operational split: a user inspecting storage in the Settings panel still had to open a terminal to migrate owned legacy repositories into the shared store or to pack the shared store, and the panel's maintenance copy had to say "the rest runs through the CLI". For an installation whose entire visible storage story lives in the panel, the two heaviest maintenance actions had no Web path at all.

## Decision

`migrate` and `compact` gain the same HTTP and panel treatment that `clean` already has, as a direct increment on the unchanged maintenance layer:

- `POST /global/storage/snapshot/migrate` (operationId `storage.snapshot.migrate`) mirrors the CLI action with `{ scopeID?, apply? }`. Dry run is the default and reports pending repositories per scope; apply moves owned legacy repositories into the per-scope shared object store under the existing journal, verification, and ref-protection sequence, and runs `SnapshotLifecycle.recover()` first like the CLI does. Repositories without a confirmed session record are reported as `skipped`, not failures — the layer already retains them unchanged. A scope-targeted request keeps the strict contract (busy storage returns 409); a batch request returns `{ results, failures }` and keeps completed work; an empty `scopeID` is rejected by schema instead of targeting every scope.
- `POST /global/storage/snapshot/compact` (operationId `storage.snapshot.compact`) mirrors `{ scopeID?, apply?, prune? }`. Dry run is the default and reports shared-store statistics; apply runs `SnapshotLifecycle.recover()` first (so dormant scopes with leftover deletion journals are unblocked without opening them or using the CLI), then the integrity check (a corrupted scope is refused whole, 409), then repacks, and with `prune` additionally collects unreferenced objects behind the existing recovery checks. A missing shared store is a no-op, matching the CLI. Batch requests follow the same partial-success envelope as migrate.
- Both handlers reuse the route conventions established by `clean`: optional `scopeID` validated as a non-empty component (all maintenance scopes when omitted), validator-based input, 409 on `SnapshotLease.BusyError`/`SnapshotStore.StorageError` for scope-targeted requests, batch `{ results, failures }` otherwise, regenerated SDK/OpenAPI contracts.
- The Storage panel's Maintenance section hosts two actions — migrate and compact — each following the panel's established flow: dry run first, confirmation dialog, apply, usage refresh. Apply-time 409s are rendered through `requestErrorMessage` so the busy/corruption reason is shown instead of a generic message; per-scope failures and per-repository failed migration results surface as warning toasts before any success toast. Migrate reports migrated/skipped counts; compact reports before/after shared-store bytes. The confirmations use the neutral tone: both operations preserve data, unlike reclaim, which permanently deletes and keeps the danger tone.
- The panel's maintenance copy no longer defers everything to the CLI; it now states that inspect/check remain CLI-only while migrate/compact/clean are available in place.

The maintenance layer itself is untouched: no new flags, no behavior change in `SnapshotMaintenance.migrate`/`compact`, no scheduler. The Web path is a transport over the exact commands an operator would run.

## Alternatives considered

- **Expose inspect/check over HTTP too.** Rejected for this increment — they are pure read/diagnostic surfaces with no mutation, and the usage endpoint already covers the panel's inspection need; a dedicated diagnostics surface can follow if wanted.
- **One combined "optimize storage" endpoint.** Rejected — migrate and compact have different risk profiles (copy-then-switch versus in-place repack), different inputs, and different failure semantics; separate operationIds keep contracts, permissions, and copy honest.
- **Auto-prune after migrate.** Rejected — pruning unreferenced objects remains an explicit `prune` choice gated behind integrity and recovery checks in the layer; the Web path must not widen that blast radius by default.
- **Keep maintenance CLI-only.** Rejected as the status quo — the panel already owns storage visibility and reclamation; leaving the two remaining mutations terminal-only forces a context switch the panel exists to remove, with no safety benefit since both actions already run under the same lease and integrity gates remotely.

## Consequences

The Storage panel is now a complete maintenance surface for everything except pure diagnostics: usage inspection, orphan reclamation, legacy migration, and shared-store packing, all dry-run-first with confirmations and 409 surfacing. Web-triggered maintenance goes through the same lease exclusion, journal recovery, and integrity gates as the CLI, so there is still exactly one safety story. The stacking order is unchanged: clean before migrate (registered repositories leave the clean candidate set), migrate before compact --prune (protected import keeps are released only after the journal reaches `cleaned`). Compact over HTTP inherits the cold-latency cost of repacking; on large stores the dry run reports size before any confirmation, matching the CLI's operator expectations.

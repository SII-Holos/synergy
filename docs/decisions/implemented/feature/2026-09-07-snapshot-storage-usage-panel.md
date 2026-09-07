# Decision Record: Snapshot storage usage panel

Status: implemented

## Problem

Shared file snapshot storage ([shared-file-snapshot-storage](../architecture/2026-09-07-shared-file-snapshot-storage.md)) gave each Scope a self-contained object store with owners, migration journals, and deletion tombstones, and shipped CLI maintenance through `synergy data snapshots inspect | migrate | compact | clean`. None of that state was visible in the Web app: a user could not see how much storage snapshots occupy per Scope, which sessions still sit on legacy repositories, or that the `snapshot: false` switch exists outside the General panel's unrelated neighbors. Asking users to drop to a CLI to answer "how big is my snapshot storage?" left the shared-storage investment invisible.

## Decision

Snapshot storage visibility ships as a read-only Web increment on top of the shared-storage layer:

- `GET /global/storage/snapshot` (operationId `storage.snapshot.usage`) returns `SnapshotMaintenance.inspect()` verbatim: per-Scope owner counts by backend (legacy/shared/deleted), retained-legacy directory counts (unowned, reclaimed, shared baselines, unregistered), and legacy/shared/index storage statistics. The endpoint performs no writes and no git operations.
- A "Storage" settings panel (system group) renders that report with a refresh action, hosts the file-snapshot enable switch (moved from General so snapshot settings live in one place), and points maintenance at the owning CLI (`synergy data snapshots ...`) rather than duplicating it over HTTP.

The HTTP surface deliberately stops at reading. Migration, compaction, and deletion go through the CLI because those operations lease a Scope offline and abort data transfer on owner-backend conflicts; exposing them as one HTTP POST would hide the cross-process coordination the storage layer is built around.

## Alternatives considered

- **A full purge/maintenance HTTP API with retention scheduling.** Built first against the pre-`#1333` per-session layout and discarded: after shared storage landed, per-session deletion is governed by the deletion-lifecycle (`beginDelete`/`completeDelete` only release snapshots for permanently deleted sessions), so an age-based Web purge would either fight that contract or bypass it. Maintenance stays CLI-owned.
- **A `snapshotRetentionDays` config key with server-side daily cleanup.** Dropped with the purge path: the shared-storage layer already owns reclamation (`compact --prune` after integrity checks) and deletion timing, so a parallel scheduler would duplicate ownership without a safety story.
- **Leave visibility to the CLI only.** Rejected — the storage cost question is a settings-panel question, and the panel costs one read-only endpoint plus one component.

## Consequences

Users can see, per Scope, where snapshot bytes live (legacy repositories versus the shared store versus rebuildable indexes) and how many sessions await migration or deletion, without shell access. The snapshot switch now lives next to the data it governs instead of inside General. The read-only boundary means the Web cannot trigger maintenance: reclaiming space still requires the CLI, which keeps leasing, integrity checks, and conflict aborts in one owner. If Web-triggered maintenance is wanted later, it should be built on the storage layer's own lease primitives rather than bolted onto this endpoint.

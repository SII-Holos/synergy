# Decision Record: Deferred Session Import

Status: implemented

## Problem

The [transactional agent authority](2026-09-14-transactional-agent-authority.md) upgrade imports historical Session records before admitting work. Large archived cohorts increase startup work. Deferring them must preserve complete migration coverage, recovery discovery, source integrity and portable transfer.

## Decision

The [staged upgrade decision](2026-09-19-staged-session-upgrade.md) extends this protocol with automatic eligibility, per-owner migration callbacks, segmented backup and a SQL catalog. This record retains the rationale for the named compatibility boundary and shared migration barriers; existing manifests keep their backup protocol.

`SYNERGY_STORAGE_COMPAT_DEFER=1` opts a newly created storage manifest into the named `20260919-session-deferred-import` boundary. The choice remains fixed across interrupted bootstrap. The packed importer seals the complete backup and imports non-Session records eagerly, while `compat_import` records track deferred Session ownership and committed file hashes.

Before any registered domain migration runs, the central runner stages every unresolved aggregate into SQL. Original files remain until the owning migrations succeed. Failed migrations leave the completion ledger incomplete and block touch imports. The staging lock retains the affected domains, so running an unrelated domain cannot release a failed owner. This includes Scope and product-owned migrations; there is no second per-Session replay registry. Malformed aggregates prevent this migration barrier from advancing until repaired.

Startup imports staged aggregates and non-archived Sessions before recovery. Archived Sessions without active flags can remain deferred only when the installed migration ledgers are already current. A later release with pending migrations first stages the remaining cohort. Touch and endpoint resolution import the aggregate before querying its indexes. Listings validate pending metadata and merge projections in memory; index writers read SQL projections only. Historical retired endpoints and nullable Channel metadata are normalized only for projections, preserving canonical history.

Imports bound record batches by count and bytes. Binary evidence is copied and hashed without whole-file buffering, made private and durable, and pinned against artifact collection before SQL references commit. All recognized source hashes and target artifacts are verified before retirement begins. A durable retirement marker permits interrupted deletion to resume. Unknown auxiliary files remain untouched. Invalid JSON, invalid metadata and missing owners quarantine the aggregate; I/O and storage failures remain retryable failures.

The Runtime owns the background ticker and its Storage Handle, limits attempted aggregates per tick, and stops and drains it before closing storage. `data/storage/compat-pause` pauses background work. Foreign-writer checks compare Session and Scope ownership using one locator inventory. Portable export, merge, move and target migration reject unresolved or quarantined aggregates; compatibility records do not cross portable archives.

## Alternatives considered

- Per-aggregate replay callbacks duplicate the migration graph and can omit Scope, workflow or future owners. Staging before the original runner preserves one migration authority.
- Deferring live Sessions hides pending inboxes and recovery owners. Startup conservatively imports non-archived Sessions before recovery.
- Sampling retirement hashes cannot detect equal-size changes outside the sample. Every source digest remains mandatory.
- A separate migrator process conflicts with namespace ownership. The existing Runtime owns convergence and shutdown.

## Consequences

Deferral applies to an up-to-date archived cohort, not every legacy Home. Homes needing schema migrations still pay the eager staging cost, and the sealed backup remains on the activation path. No startup speedup or disk-space reduction is claimed without measurements of this final implementation. Pending listings retain a metadata-scan cost during convergence.

Quarantined aggregates preserve their original evidence and block portable transfer. The immutable backup represents pre-upgrade data; it does not include subsequent SQL writes. The boundary remains opt-in and inert for ordinary installations.

## Validation

Behavioral regressions cover cross-domain migration ordering and failure, historical writer upgrades with deferral enabled and disabled, current-schema archived activation, endpoint discovery, projection isolation, same-size source drift, missing/malformed owners, binary preservation, transient I/O, recovery preparation and ticker shutdown. Export checks cover pending and quarantined owners.

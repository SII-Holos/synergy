# Decision Record: Fence previous organization Home readers

Status: implemented

## Problem

A previous Runtime can reopen an organization Home without understanding permanent transfer epochs, organization binding adoption, command closure or maintenance holds. An optional marker, member-only exemption or maintenance-only contract lets an older startup reader accept that Home. Recreating the machine identity or keys to force rejection would break established ownership and enrollment.

## Decision

Fresh member and hosted Runtime Homes use version 2 for both the Harness Home ownership file and organization binding, with the required `native-organization-ownership-v3` reader contract. It covers native maintenance, permanent transfer epochs and surrender/retirement, organization adoption, required command portability readers explicit native execution origins and canonical Environment Use ownership. The owner remains `organization-runtime`, its identity digest retains organization/account/device or organization/host attribution, and machine credentials do not rotate. Harness ownership selection must match the persisted version and exact reader contract as well as owner and identity. Product build strings do not replace these checks.

Fresh organization provisioning writes the fenced format. Reading or preparing an existing version-1 Home never performs an implicit upgrade. The organization Runtime registers one owning `organization-home-reader-fence-v2` maintenance migration with the central runner. Its explicit `upgradeOrganizationHome` entry requires the actual current opaque maintenance lease in the frozen phase, the same Runtime Home/root and the configured member or hosted identity. Direct migration execution without that context is rejected. There is one current reader and migration path; unknown version-2 contracts are not silently adopted.

The supported upgrade is legacy version 1 to current version 2. Unpublished intermediate version-2 Homes requiring `purpose-bound-maintenance-v1`, `native-organization-ownership-v1` or `native-organization-ownership-v2` are deliberately rejected by ordinary startup without modifying their identity or keys. They do not become another live reader or implicit migration entry. Sealed historical hosted archives use the same owning codec with an explicit archival reader-contract enumeration; their lower ownership and organization-binding contracts must agree. Accepting an authenticated historical archive never authorizes active startup under its old reader. `test/home-unsupported.test.ts`, `test/home-fence.test.ts` and `test/backup/native.test.ts` fix these boundaries.

The file owner validates identity, origin and existing credentials before publication. `RuntimeMaintenance.withFrozen()` holds the native operation lock across the actual file work, preventing a concurrent source release from reopening admission between publications. It grants no ordinary mutation bypass. The migration publishes the version-2 Home ownership fence before the dependent organization binding under private file locks and durable atomic writes. Cancellation reaches both the migration lock and lower Home ownership lock with its original reason, so a retained lower lock cannot trap the frozen native lifetime. An interruption between publications leaves the old reader fenced and the new ordinary reader unavailable. The same central migration resumes that exact partially upgraded pair; it does not create new keys, adopt a personal Home or bless an unknown reader contract. An inconsistent reverse publication order and damaged files remain errors.

Already fenced fresh Homes can prove that the file migration is applied without running an upgrade. Completed migration receipts must still agree with the canonical files at the explicit entry. Removing a marker or changing its contract cannot silently establish a replacement baseline.

## Alternatives considered

**Add optional fields to version 1.** A prior reader may ignore them; it would retain startup authority while lacking the actual maintenance contract.

**Version only the organization binding.** That does not fence the lower Harness Home reader, which must independently reject a Home requiring another reader contract.

**Change the owner string or replace machine keys.** Those fields identify the existing ownership and enrollment. The format expresses reader compatibility without changing that identity.

**Upgrade during ordinary Home reads.** It cannot establish native writer drainage and would hide a migration behind startup admission. The explicit central maintenance path retains that boundary.

## Consequences

This is a startup reader fence and controlled file-format upgrade. It does not prove that an already running older process, remote job or physical writer stopped. The full operator must still inspect and drain the actual writer cohort, coordinate hosted/resource/Snapshot capture and establish a new deployment's execution fences. A synthetic test owner is not evidence that those production participants are complete. The recovery format remains separate from browser account authorization.

The Home and registration readers remain Node-compatible; they do not load Agent lifecycle or Bun networking. Only the explicit native migration module uses the Runtime, Storage and central migration owners.

## Verification

`organization-runtime/test/home-fence.test.ts` rejects a separate Node process running each previous strict reader for each Home kind. `test/home-migration.test.ts` proves that reader opens each legacy fixture before upgrade and rejects it afterward, with unchanged machine credentials and digest. It also covers copied leases, wrong Home/identity, non-frozen operations, interrupted publication, cancellation behind a real ownership lock and unknown contracts. `test/home-worker-fence.test.ts` runs actual pinned-component agent and policy processes: the previous version-1, maintenance-only and origin-unaware readers become ready with their matching historical marker and reject the current marker before readiness, despite equal product version strings and no stored execution records. This does not substitute for final sealed installed-generation acceptance. Harness `test/storage/runtime-maintenance.test.ts` holds real protected work behind a barrier and verifies a concurrent release cannot advance the phase or admit a canonical write before that work finishes. Existing member Node provisioning, generic Harness ownership and real hosted Runtime execution remain selected.

## Related

- [Organization architecture](../../../architecture/organization.md)
- [Purpose-bound maintenance](2026-11-11-retain-purpose-bound-runtime-maintenance-holds.md)
- [Hosted machine authority](2026-11-11-separate-hosted-machine-authority.md)

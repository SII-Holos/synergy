# Decision Record: Fence previous hosted Home readers

Status: implemented

## Problem

A previous Runtime can reopen a restored hosted Home without understanding the new maintenance holds. An optional marker or an unchanged format version would let its strict startup reader accept that Home. Recreating the machine identity or keys to force rejection would break established ownership and enrollment.

## Decision

Hosted Runtime Homes use version 2 for both the Harness Home ownership file and organization binding, with the required `purpose-bound-maintenance-v1` reader contract. Member Homes retain version 1. The owner remains `organization-runtime`, its identity digest remains organization/host based, and machine credentials do not rotate. Harness ownership selection must match the persisted version and reader contract as well as owner and identity.

Fresh hosted provisioning writes the fenced format. Reading or preparing an existing version-1 hosted Home never performs an implicit upgrade. The organization Runtime registers its owning `hosted-home-reader-fence-v2` maintenance migration with the central runner. Its explicit native entry requires the actual current opaque maintenance lease in the frozen phase, the same Runtime Home/root and the configured hosted identity. Direct migration execution without that context is rejected.

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

`organization-runtime/test/hosted-home-fence.test.ts` first observes the unfenced version-1 result, then checks both new files and a separate Node process running the retained previous strict Home reader. `test/hosted-home-migration.test.ts` proves that reader can open the legacy fixture before upgrade and rejects it afterward, with unchanged machine credentials and digest. It also covers copied leases, wrong Home/identity, non-frozen operations, interrupted publication and unknown contracts. Harness `test/storage/runtime-maintenance.test.ts` holds real protected work behind a barrier and verifies a concurrent release cannot advance the phase or admit a canonical write before that work finishes. Existing member Node provisioning, generic Harness ownership and real hosted Runtime execution remain selected.

## Related

- [Organization architecture](../../../architecture/organization.md)
- [Purpose-bound maintenance](2026-11-11-retain-purpose-bound-runtime-maintenance-holds.md)
- [Hosted machine authority](2026-11-11-separate-hosted-machine-authority.md)

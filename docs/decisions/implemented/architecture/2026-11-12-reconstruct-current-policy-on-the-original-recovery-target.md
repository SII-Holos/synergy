# Decision Record: Reconstruct current policy on the original recovery target

Status: implemented

## Problem

An isolated target restored from H0 can retain permissions and private authentication facts that the source changed before its final H1 checkpoint. Redacted journal entries prove continuity but cannot reconstruct password hashes, resource credentials or other original private records. Replaying old commands or replacing the entire target namespace would also discard its actual installation and recovery-held ownership.

## Decision

`OrganizationRecovery.withTarget` binds the actual native installation permit, verified service-native segment and inactive prepared signer to their original Runtime, primary Store, request and callback. The coordinator obtains the target reference only from those original owners. A metadata object or another target cannot substitute for that evidence.

The original `OrganizationCurrentAuthority.Source` supplies its fixed authenticated H1 namespace and native descriptors through a bounded callback. Its verified earlier anchor must equal the actual prepared target's H0 checkpoint. Captured descriptors are integrity inputs, while the original Source and Target objects retain authority. An owning pure lifetime/configuration/signal guard can run on the target's final SQL commit without switching Runtime contexts or doing physical I/O there.

The canonical Journal owner stages the complete authenticated namespace using its existing decoder, chain verifier and registered policy projectors. It retains the full original covered records privately, including fields omitted from the redacted journal. The source's immutable retirement reference binds that final namespace and the original prepared target. Source retirement must complete before target publication.

Inside the original `RuntimeMaintenance.restorationTransaction`, the coordinator invokes [canonical Journal adoption](2026-11-12-adopt-verified-current-authority-through-original-target-transactions.md) and commits one strict installation/reference/checkpoint receipt in the same transaction. The Journal owner retains responsibility for complete private facts, deletions and original H1 history. Exact retries validate the receipt and still invoke native adoption, so matching H1 metadata cannot hide missing raw reconstruction. The actual target, original source lifetime and cancellation checks remain on the outer commit boundary alongside the adoption owner's guards.

If the last target write is cancelled, target H0 and its recovery hold remain intact while the already committed source fence stays permanent. The same live Source scope can recompute only the exact reference retained by its format-four marker and retry the original target. It cannot capture a new ordinary source from that retired Home or nominate another target.

## Alternatives considered

**Replay the journal's after values.** They are deliberately redacted projections rather than the original canonical private facts.

**Restore the entire H1 namespace over the H0 target.** That would replace the original import and native restoration relationship, including the target's independent hold.

**Accept a matching head or publication receipt without reconstruction.** A valid head does not establish that all original private fields were installed.

**Publish target policy before permanently fencing the source.** A later source writer could change current authorization or leave competing control planes.

## Consequences

The original target can reconstruct genuine final source policy without changing its deployment, active signer, inactive prepared material or recovery-held state. This is policy reconstruction, not fresh authority publication, unique-writer reconciliation, readiness or execution admission.

`packages/organization/test/backup/authority.test.ts` uses the real encrypted H0 backup, actual native/Snapshot/SQL installation and inactive signer, a later real password change, current source capture and permanent source Home fence. It checks a wrong anchor before fencing, original target evidence, last-write rollback, exact retry and receipt retry, full H1 private account data and covered history, and unchanged deployment/signing/authentication records with readiness closed. The native Journal adoption suite independently verifies complete private rows, deletion, archive integrity and transaction lifetime.

Reconstruction after the original Source callback closes uses the [fixed cold recovery path](2026-11-12-reopen-fixed-recovery-policy-after-source-retirement.md), binding original archive hashes to a freshly verified physical source receipt without signing another Current source. Member/hosted/resource writer reconciliation, current native setting publication, retirement of old login authority, fresh signer activation and paused-ready startup remain separate required owners before PRD recovery acceptance.

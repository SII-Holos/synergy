# Decision Record: Recover validated knowledge metadata appends

Status: implemented

## Problem

A fixed H1 checkpoint can contain a newly published knowledge version that reuses content already sealed in the H0 backup. Current policy adoption includes its knowledge item, but the original Target lacks its immutable release and publication metadata. Requiring identical unprojected records blocks an otherwise verifiable recovery; adopting the item alone would leave an incomplete reference graph.

## Decision

The existing Knowledge historical reader identifies appendable release, publication-receipt and catalog-index keys only after their canonical codecs, attribution, references, manifests and inverse relationships validate. Publication bytes retain their original full verification. Selection updates, unknown keys and other owners receive no append authority.

Recovery stores these individually verified keys in its temporary on-disk inventory. The original Target preflight permits only missing marked metadata. Existing keys must equal their fixed H1 values, and the complete original artifact inventory and actual bytes must still match. No directory or storage root is accepted as a substitute for owner evidence.

Inside the original restoration transaction, current Journal adoption precedes publication of the missing metadata. The publisher reads bounded pages through the actual Target transaction, writes only absent keys and rejects conflicts. Final sealing re-reads every marked key with missing entries forbidden, verifies the complete inventory and prevents later writes. The actual COMMIT guard requires the original live owner and a completed, unfailed seal. A caught publisher failure remains fatal to that transaction.

Both initial publication and receipt reconciliation perform these checks. An acknowledged SQL publication can be recovered after its reply is lost through the same fixed H1, original Target and retained key. No new schema, phase ledger, public command or native binary preparation is introduced.

## Alternatives considered

**Replay live knowledge publication.** Rejected because recovery must retain original versions, authors, receipts and request identities without issuing another publication.

**Copy a whole historical root.** Rejected because unrecognized records and missing inverse references would gain publication without their owning validation.

**Accept missing metadata during final sealing.** Rejected because preflight permission to prepare a delta cannot certify its successful transaction. Skipped or swallowed writes must still roll back.

## Consequences

Service recovery can include validated H1 knowledge metadata whose original sealed content is already present in H0. Current policy and login changes remain authoritative. New physical content, Artifact deltas, Selection changes and unrelated writer owners still require their own verified recovery paths.

## Verification

The public CLI fixture publishes a new H1 release from H0 sealed bytes and verifies its original version, receipt, full bytes and checksum after two ordinary cold starts. It retains the original prepared key, permanently fenced Source and current password policy while execution stays disabled. A real Target transaction fixture skips publication, catches a late failure after an actual row write, loses an acknowledgement after SQL COMMIT and retries the same fixed H1. It verifies rollback of the original held SQL head and missing metadata, then exact reconciliation of the committed receipt. Existing missing, corrupt and unsupported historical inputs remain rejection cases.

The complete knowledge CLI file passes seven cases and 263 assertions. The existing caught-final-artifact-mismatch neighbor passes 11 assertions, retaining its actual transaction rollback. Organization typecheck, owned TypeScript formatting/lint and documentation/decision checks pass. These counts exclude earlier overlapping diagnostic and single-case runs.

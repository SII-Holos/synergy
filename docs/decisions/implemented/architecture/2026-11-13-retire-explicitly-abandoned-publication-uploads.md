# Decision Record: Retire explicitly abandoned publication uploads

Status: implemented

## Problem

An interrupted publication upload retains immutable chunk references indefinitely. Expiring it by age or by absence from a current catalog cannot distinguish an unfinished draft from an immutable release retained by a Skill, historical version, execution or recovery owner.

## Decision

The publication owner accepts an explicit abandonment request from the original author under current publication write authorization. One SQL transaction changes only an open or sealing upload to the terminal `abandoned` state and records its original request, author, prior state and time. The original create request still resolves to that upload. A matching abandonment retry returns the same receipt; another request conflicts. Sealed uploads cannot be abandoned.

Abandonment does not wait for the sealer's verification lock. The sealer's final transaction requires the current `sealing` state, and its error path resets only that state. Both a held verifier and a held native chunk preparation therefore lose their right to publish after abandonment. Existing chunk receipts cannot resume an abandoned upload. Exact author identity and current authorization remain part of the final writer transaction.

Stored upload headers advance to version two through the publication owner's centrally registered startup migration. Bounded writer-owned pages validate legacy and current state before rewriting. Malformed pages roll back, previous completed pages are retryable, and current rows, bytes, file declarations and request receipts remain unchanged. A sealed manifest cannot be represented as an abandoned or open header.

The trusted ordinary service Host exposes `maintenance.retention.uploads.mark`, `status` and `collect`. Marks retain the exact abandonment receipt, upload, operator, deployment incarnation, request and positive delay. Collection enters the existing accepted service operation and uses the same actual SQL transaction for current deployment and terminal receipt checks, canonical artifact inspection, logical removal and its collected receipt. The original Runtime, Store and open callback guard reaches the actual COMMIT. A backup drains an already accepted collector while rejecting a new collector. No frozen-write exception or new native deletion authority is introduced.

Collection removes only the known chunk artifact references under the publication owner's exact bytes prefix. It preserves the upload header, original create and abandonment requests, file declarations, chunk receipts and collection receipt. Unclassified artifact keys, inconsistent metadata, unknown state or changed terminal evidence preserve the references. The original Store queues pack garbage; native pack and object owners retain physical deletion, preparation pins and backup checkpoints. An open checkpoint can still stream its original bytes after logical removal.

Artifact and Knowledge writers require a sealed upload and verified manifest in their final publication transaction. Existing writers never reopen a sealed upload. This permits the narrow never-sealed owner to prove eligibility from its own terminal transition, without treating an absent reverse index as proof. Every sealed upload remains retained, including an older published version no longer selected as latest. Shared copies, handoff and WorkspaceMove staging, Snapshot objects, sealed releases and their references keep their existing owners.

## Alternatives considered

**Expire inactive or apparently unreferenced uploads.** Age and current catalog absence cannot prove that an immutable publication or retained execution no longer needs its bytes.

**Wait for the sealer before accepting abandonment.** This prevents the author from stopping a held verifier and lets verification win solely because it already holds a local lock. The terminal SQL state is the shared publication authority.

**Delete native packs when dropping logical references.** Other copies, active preparation and backup checkpoints have independent native owners. Logical collection queues their existing reclamation path instead.

**Build the complete published-version reference graph first.** Such an index is required for a future sealed-version retirement policy. It is unnecessary for the explicit terminal transition that current publication writers cannot reference.

## Consequences

Unfinished uploads now have an explicit, recoverable logical retirement path. Real HTTP and Store fixtures verify old-data startup, cold retries, held verification and preparation, queued revocation, retained historical Knowledge bytes, malformed migration rollback, unknown artifacts, deployment changes, checkpoint bytes and backup drainage. This unit provides no age-based cleanup, sealed-version reclamation or automatic policy scheduler. It does not establish complete deployment GC or physical reclamation coverage.

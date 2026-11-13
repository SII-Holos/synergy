# Decision Record: Verify original published Artifact history through its owning readers

Status: implemented

## Problem

Authentic H0 backups can contain project Artifacts published from a genuine completed Hosted task. The current Journal only projects Artifact item authority. The original versions, publication receipts, indexes, sealed upload manifests and native bytes require their own historical closure. The knowledge-only upload-purpose guard therefore rejects this otherwise retained immutable history before current-policy reconstruction.

## Decision

Add a pure historical reader in the existing Artifact owner, consuming its private Item, Version, Receipt and canonical key builders. Verify original organization/project/account identity, contiguous version and revision history, the latest Item fields, original author snapshots, the project index and complete bidirectional receipt references. Preserve request digests as original opaque facts; do not reconstruct missing old Publish inputs or infer a source actor from current authority.

Fold Publication create receipts once in Writers, then run Knowledge and Artifact readers against the same disk inventory. Every upload consumer supplies the expected purpose and source identity explicitly. Artifact uploads must match their original project, author, source Session, manifest and byte totals. Reuse the existing Publication sealer for canonical paths, reverse path indexes, full-file SHA, chunk evidence and actual native checkpoint bytes. An Artifact's original source Session may be deleted or inaccessible; the historical source reference does not require current source access and does not authorize execution.

Only exact canonical keys marked by these owners may enter the unchanged H0/H1 history class. Every unmarked record or native byte key remains blocking. Preserve the existing bidirectional original Target comparison, actual Target bytes, checkpoint pins and final commit guards. The additional root names only route marked-key checking; they are not safe-root authority. H1 new versions remain unsupported and fail before either permanent source fence even when their bytes are already sealed.

## Alternatives considered

**Whitelisting the Artifact root** cannot establish version, receipt, index or native-byte completeness.

**Copying a manifest/parser into recovery or the CLI** duplicates the canonical publication sealer and would separate live and historical validation.

**Requiring the original source Session to remain readable** violates the existing published Artifact contract and would discard independent project outputs.

**Rebuilding new H1 Artifact versions** requires a separate owning reconstruction protocol. Exact unchanged history does not imply support for such imports.

## Consequences

The supported case is immutable Artifact history fully published at H0 and unchanged in H1, composed with the already supported genuine Hosted/task writer owners. No protocol, migration, key, phase ledger or CLI behavior is added. Open, sealing, abandoned or unknown uploads, changed/new H1 content and unsupported member/Library/external owners retain their guards. Recovery remains paused with no task replay or implicit Continue.

## Verification

The genuine Hosted fixture publishes two versions using generated HTTPS APIs before H0, then performs original service and Hosted retirement/restoration, cold ordinary startup, fresh owner login, exact version/receipt/reference/full-byte/Range reads and existing paused/root/actor/no-replay assertions. The original knowledge-only guard produced 0/1/18; the owning implementation passes 1/57. A real H1 third version passes the refusal fixture (1/28), confirming both original Homes stay format two, no retirement reservation exists and both original maintenance leases release.

The focused Artifact owner file passes 5/8 with real Store/checkpoint bytes: removed source and changed/removed author preserve old snapshots/content after restart; missing original version, index or receipt and changed upload/source binding reject. The unchanged six-case knowledge recovery file passes 6/202 after the common request fold moved. Existing Artifact and publication-receipt neighbors pass 7/50. Complete Organization and OrganizationRuntime typechecks and owned seven-file lint/format checks exit zero. These are focused temporary-Home results, not full DATA20 acceptance.

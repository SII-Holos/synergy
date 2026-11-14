# Decision Record: Stage artifacts through original restoration ownership

Status: implemented

## Problem

A recovery-held Target can already contain H0 data while a verified H1 archive contains additional artifact bytes. Ordinary checkpoint restoration requires an empty destination. Preparing binaries inside its later artifact checkpoint would reenter the same native gate, while retaining one preparation token per artifact would grow memory with the archive.

## Decision

`RuntimeMaintenance.withRestorationArtifacts` binds the original installed Home permit and request, the actual committed H0 import receipt and complete H0 manifest hash. H1 must authenticate completely and retain that namespace identity. The original Runtime, actual primary Store, configuration, native artifact owner and callback remain fixed throughout preparation and publication.

The existing Checkpoint staging owner indexes selected archive keys on private disk and prepares one binary at a time outside SQL and native checkpoint gates. Short original restoration transactions retain references under its existing staging root, qualified by installation, request, H1 and complete selected-key identity. Preparation tokens settle independently; uncertain native outcomes retain their last pack pin. External object-artifact behavior remains unchanged.

Every staged body is streamed and checked against its authenticated checksum before its exact native location becomes a private witness. Cold reconstruction verifies retained references before issuing new callback-bound evidence. Metadata hashes alone cannot certify a substituted native reference.

The original restoration transaction installs a mandatory alias-completion guard before entering the business callback. Publication accepts only the witnessed references, writes their canonical aliases and removes only its own staging group. The final mutation guard protects those aliases and the entire checkpoint staging namespace, including sibling and ancestor operations. Missing publication, caught failures and late writes reject the actual COMMIT.

Ordinary checkpoint restoration keeps its empty-destination requirement. The new native evidence grants neither current-policy authority, domain metadata reconstruction, recovery readiness nor execution. The domain must independently approve selected keys and validate its final complete inventory.

## Alternatives considered

**Reenter ordinary restoration with another import identity.** Rejected because it would bypass the original nonempty Target and fixed installation relationship.

**Prepare under the checkpoint or SQL writer.** Rejected because preparation owns the same artifact gate and may perform physical I/O outside retryable transactions.

**Keep all prepared tokens in memory.** Rejected because artifact count would determine retained memory and uncertain token cleanup would endanger the final bytes.

**Trust matching checksum metadata after staging.** Rejected because a public reference operation can replace a native location without changing its declared hash and size.

## Consequences

Trusted recovery owners can stage bounded native artifact increments on their original nonempty held Target and resume the exact preparation after interruption. Unknown, foreign and differently selected staging remains retained and unavailable to another preparation. Full organization content reconstruction and PostgreSQL acceptance require their own subsequent evidence.

## Verification

Six independent behavioral selectors pass 51 assertions against real native storage: nonempty publication and expired/foreign owner refusal; same-hash location substitution; a caught foreign sibling write after alias publication; unknown native commit with garbage collection and cold reuse; skipped/caught publication with exact retry and alternate H1/selection refusal; and H0/namespace anchor rejection. Both native-reference substitution and post-publication sibling insertion produced actual REDs before their witness and mutation-guard fixes. The six results are separate runs, with no duplicate positive run added to the total. PostgreSQL execution is registered but is not claimed by these native results.

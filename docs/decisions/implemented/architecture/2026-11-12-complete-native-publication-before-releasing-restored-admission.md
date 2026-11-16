# Decision Record: Complete native publication before releasing restored admission

Status: implemented

## Problem

Restoring the original namespace and current policy intentionally leaves the target recovery-held. A committed domain publication alone cannot establish that current native settings are installed, and completing a native file alone cannot authorize ordinary startup or release an unrelated maintenance operation.

## Decision

Each recovery domain registers a publication owner during composition. That owner reads its actual canonical receipt and current native settings, reporting the fixed publication hash, native readiness and original maintenance release. Callers cannot supply a verifier. `HomeRestoration.withPublication` binds an opaque callback permit to the actual primary Store, original native target identities, process lock, format-three owner and matching committed publication.

`completePublication` requires confirmed current native settings. It appends a version-two completion frame to the original intent through its verified single-link file descriptor. The original canonical staging frame remains intact. Both frames together represent the completed intent; earlier single-object readers reject the format. Only a tail that is an exact prefix of the registered owner's fixed publication can be repaired. Interrupted writes preserve the original installation identity; an uncertain sync acknowledgement is reconciled by reading the same completed frame.

`RuntimeMaintenance.releaseRestoration` consumes that permit after native completion and current domain verification. Its guarded transaction releases only the original adopted target, retaining both source and target history snapshots. Ordinary release still rejects restored holds. Idempotent release validates the exact prior transition. Ordinary startup independently verifies both native frames, actual domain readiness and the matching released operation before removing the Home guard.

## Alternatives considered

**Release after the domain transaction.** Native configuration may still be absent or outdated, and a restart could advertise readiness before it installs the committed policy.

**Rewrite the original intent through an absolute pathname.** A replaced directory could receive another target's completion. Truncating the original descriptor first would also lose its recovery identity after a partial write.

**Accept caller-supplied readiness or ordinary release.** Neither proves the domain's actual receipt, current native settings or original recovery-held target.

## Consequences

The native primitive separates committed publication, completed native installation and released admission without a second phase ledger. Restricted recovery can inspect the original frame after interruption; ordinary startup rejects an incomplete or unverified tail. Focused tests use a real imported namespace, actual Home owner and native settings file, partial descriptor writes, lost sync acknowledgements and cold idempotent startup. Domain writer reconciliation, new credentials and product readiness remain the registered domain owner's responsibility.

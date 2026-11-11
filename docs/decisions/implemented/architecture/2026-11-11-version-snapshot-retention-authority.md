# Decision Record: Version Snapshot retention authority

Status: implemented

## Problem

Snapshot content can be installed under a private preparation owner before Session publication. Adopting its Git refs into the real Session before the epoch transaction would expose ownership too early, while a failed SQL commit could leave those refs behind. A version-2 reader strips unknown metadata fields, so adding an unversioned retention pointer could silently resolve the wrong identity.

## Decision

Version canonical Snapshot owner and deletion records as version 3 with an explicit `retentionID`. This is the one physical retention identity used by native reads, external Snapshot storage, later captures and permanent deletion. Ordinary owners initially retain under their own Session ID. A transferred Session can instead adopt an already verified private identity through its canonical owner transaction. Readers never try a second namespace as a fallback. Existing immutable Git bytes and the selected external storage mode retain their current formats.

The owning `snapshot-ownership` record migration registers with the central runner. It converts exact historical version-2 owner/deletion keys to self-retention. Requested reads and portable imports use that same pure transformation before validating the current schema; they do not write back through ordinary history handlers or scan all ownership records at startup. Explicit migration work can persist changes in bounded metadata pages. A historical version-2 record that already claims retention indirection is rejected, as are unknown versions. Version-2 readers reject the new version instead of dropping its authority field.

An absent or deleted canonical Snapshot owner grants no read authority even when a matching Git ref or durable content remains. Removing the private preparation owner and installing the real owner can commit together in SQL; rollback restores the previous owner exactly. This is an ownership primitive, not a claim that native file installation and SQL share a transaction. Signed handoff preparation must still verify immutable content before activating any Session or ownership record.

The existing Snapshot owner resolves all subsequent retention through `retentionID`. Permanent deletion preserves that identity in its durable job, removes its native refs and asks the selected Snapshot backend to release the corresponding canonical bytes. Archive merging rejects a conflicting retention identity and accounts for physical identities when excluding logical Sessions. Offline content conversion deliberately installs a new target-owned self-retention identity.

Ownership batches resolve only the requested refs and verify both the expected object ID and tree type. They use bounded `git cat-file --batch-check` requests with the original expected ID carried in `%(rest)`, rather than enumerating every ref retained by the owner. See [Git's batch output contract](https://git-scm.com/docs/git-cat-file#_batch_output).

## Alternatives considered

**Add an optional field to version 2.** Released readers would discard the field and silently select the wrong namespace.

**Publish real Session refs during preparation.** Their presence would survive a failed Session transaction and grant premature ownership.

**Read both the old and transferred namespaces.** Two candidate identities would compete for authority and complicate later capture, deletion and recovery.

**Change production Snapshot objects to another backend.** The ownership problem does not require changing immutable object storage or adding a backend fallback.

## Consequences

Real native and stored-backend fixtures verify preparation isolation, SQL rollback, adoption, later retention, deletion and restart. A stored-backend restart removes the local Git cache and reconstructs history through the adopted canonical identity. Cold version-2 records retain their historical meaning; new, malformed and unknown versions have explicit outcomes. A batch reading one root does not inspect the owner's other retained refs.

This unit establishes versioned ownership and cleanup. Complete streamed Snapshot export, private target verification, signed activation integration and retirement-aware staging collection remain separate handoff work. Those integrations must retain private objects until a verified activation or permanent retirement decision; installing bytes alone cannot authorize a Session.

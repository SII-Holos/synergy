# Decision Record: Prepare recovery signing without forking source authority history

Status: implemented

## Problem

A backup fixes a source authority journal at one head. The source can continue after capture and append legitimate changes at later sequence numbers. Immediately changing the restored identity through that same journal would create a competing suffix before recovery knows the source's final head. A fresh key or local writer lock cannot establish current authorization or retirement of that source writer.

## Decision

The organization recovery authority owner prepares a fresh Ed25519 material without changing any active SQL record or journal entry. It requires the original callback-bound Home installation permit and request, actual installed permanent ownership, the committed raw-import receipt and the maintenance owner's matching committed recovery-held reference. Source operation history remains unchanged. The service native owner exposes independent metadata copies from its private verified installation snapshot; mutable presentation fields cannot replace that source evidence.

`AuthorityJournal.readArchivedCheckpoint()` consumes the canonical checkpoint parser and recovery keys through complete authenticated EOF before returning its own parsed historical head. It does not authorize current access or assert source retirement. The target's complete journal inspection must still match that head and its registered projection contract.

The signing owner supplies the same generation and key-pair validation used by ordinary signing initialization. Recovery stores exactly one version-one encrypted material in an installation-specific native quarantine directory. The canonical secret envelope authenticates the original installation ID, generated incarnation, full request and namespace hashes, native facet hash, historical head, original public signing identity, public OAuth definition hash, fresh public identity and creation time. PKCS8 plaintext never enters this native file or its safe inspection result. There is no second phase ledger or active signer interface.

The existing native installation lock and a Runtime-local bounded queue serialize publication. Atomic private durable publication retains the first material across a lost acknowledgement. Cold retry requires the exact references and external recovery key, validates the original key pair and returns the same public identity. A conflicting, foreign or unauthenticated file is preserved and rejected rather than replaced. Prepared evidence is private, callback-bound and independently inspectable only through cloned safe metadata; verification re-reads and authenticates its material through the same native owner.

## Alternatives considered

**Append a target recovery action at the archived head.** A still-running source can already own that next sequence. Preserving the copied head does not prove its suffix is complete.

**Replace active signing or expire copied tokens immediately.** That is an authority transition with durable history and owner obligations. Preparing a key does not provide the final source suffix, current policy or physical writer evidence needed for that transition.

**Use native display metadata or supplied hashes as installation proof.** Those values can be copied or mutated. Preparation consumes the actual Home, import, maintenance and private native evidence for the same original request.

**Regenerate after an uncertain publication.** That would lose the first key's identity. An existing encrypted material must authenticate before reuse or block recovery.

## Consequences

The target can prepare its future signer without branching source history. Its old signer, login/API tokens and machine registrations remain unchanged and inert only because the target is still restricted and recovery-held. They are not reported as revoked. No ready state, normal read authority or Continue capability is issued.

The active transition remains dependent on the actual final source suffix, current owning policy snapshots and old-writer retirement evidence. The prepared file is canonical unpublished native material protected by its own envelope; the complete recovery/backup coordinator must include it in the appropriate native facet or retire it after the actual active publication. This unit does not establish full recovery, native resource reconstruction or complete deployment backup coverage.

## Verification

`test/backup/authority.test.ts` captures an actual initialized service, then changes its password through the normal authenticated API to produce a genuine later journal head. A separate restricted Home imports the original checkpoint and adopts its hold. Preparing and cold-retrying the new material leaves its deployment, original signer, authentication records and old journal head unchanged. The tests cover mutated native display metadata, independent safe views, uncommitted imports, lost durable acknowledgements, wrong material keys, a copied material in another actual Home, original cancellation during key retrieval and expired evidence.

`test/storage/authority-journal.test.ts` verifies a historical head from a protected checkpoint with a different opaque namespace label, rejects a truncated authenticated archive and retains original cancellation. Existing signing, history and service-native installation tests retain ordinary startup, key preservation, complete import and native fence coverage.

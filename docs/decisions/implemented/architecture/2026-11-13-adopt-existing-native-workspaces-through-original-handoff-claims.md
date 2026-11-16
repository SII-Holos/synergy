# Decision Record: Adopt existing native workspaces through original handoff claims

Status: implemented

## Problem

Moving a native or cloud-backed Session to a member does not establish which version of an existing native directory the member accepted. A captured file hash cannot replace current directory ownership, complete differences, or the final Session publication transaction. Cancellation can also overtake an accepted preview or native claim acquisition. The [nested release failure](../../../postmortem/0168-workspace-move-release-escaped-an-outer-transaction.md) demonstrates why physical release cannot join an enclosing SQL transaction.

## Decision

An explicit `organization-native` or `native-existing` mapping selects an existing project Workspace, generation, catalog revision and project-selection revision. Initial mapping consent fixes its actual member actor. Source preparation freezes the original Session cohort. A Cloud source captures its current service subtree through the existing Workspace archive owner and retains no native claim for a pathless remote Locator. A native source instead retains the actual original FrozenFiles graph through its native physical capture and binds the complete subtree to the signed source fact; it does not manufacture a Cloud resource or dispatch a Cloud source RPC.

The target verifies the complete staged cohort before reserving its original inactive Epoch. The same WorkspaceMove intent compares the verified source graph with a real native capture, including Git metadata, ignored and untracked files, removals, modes and links. Its derived SQL index pages headers without re-reading bodies. A new target capture replaces the previous derived index through the original Move transaction. Second consent binds the mapping revision and exact source snapshot, target digest and difference hash. Source-head, project-selection, catalog or physical changes block preparation or publication and require review.

Adoption selects the target directory's version; it does not overwrite either tree. Native preparation retains the original durable Workspace claim and complete receipt. The actual Core/catalog/Epoch transaction records the same Move's native publication hash and installs its synchronous physical, signal and lifetime guards. Release runs outside SQL. Its actual terminal commit closes accepted publication admission before draining the original job and confirming physical release, including unknown acknowledgements through the original identity. Published native effects cannot become a cancellation outcome.

Cancellation drains accepted preview or preparation work, permanently marks the actual inactive target Epochs never-activate, and releases the original Move before returning its corresponding signed target fact. A preview release does not claim a prepared hash. An unacknowledged local preparation uses that same inactive retirement path. Source cancellation remains a separate canonical fact.

Owning central migrations retain supported Handoff and native receipt formats without changing their immutable hashes. Existing organization-to-native mappings retain their Workspace and Environment compatibility requirements. The new native-existing choice requires both participants to advertise bridge nine before Source inspection or freezing; an older bridge cannot partially enter it. History grants no allocation, execution or publication authority.

## Alternatives considered

**Copy into a fresh directory.** This preserves a useful independent legacy operation but cannot represent acceptance of the existing target's version.

**Publish first and retain differences afterward.** This loses the member's exact second consent and permits stale target publication.

**Add a parallel native coordinator or cancellation ledger.** This duplicates the existing Move, Epoch and Handoff authorities.

**Release from an enclosing SQL callback or an after-commit notification.** This can release a physical claim before rollback or hide a committed unknown result.

## Consequences

Both original native directories, any selected Cloud source bytes and the paused Session identity remain independently verifiable. Tests cover complete TLS return, strict consent hashes, source-head changes, held preview and claim acquisition, prepared cancellation, both publication/cancellation commit orders, lost terminal acknowledgement and outer-transaction rollback. See [Workspace ownership](../../../architecture/workspace-and-files.md) and [organization handoff](../../../architecture/organization.md).

Cloud-object and native frozen-file sources share the same existing-directory adoption owner. Current Working selects the explicitly accepted target files, while original message actors, history and Snapshot objects remain retained. Downloads, remote compute and independent Continue use their separate integrated owners. Default keep-cloud behavior and legacy fresh private copies retain their own semantics. The [integrated Environment and Workspace handoff](2026-11-14-bind-logical-environment-mapping-to-native-handoff.md) supplies the public controller without replacing exact native adoption consent. Machine receipts use [immutable acknowledgements and limited cleanup inspection](../bug-fix/2026-11-13-acknowledge-only-original-handoff-machine-facts.md); account or device revocation recovery remains separate.

## Verification

The real enrolled HTTPS/WSS native-existing Runtime fixture completes source freeze, paged differences, exact second consent, surrender, commit and paused activation, then independently Continues against the accepted target bytes. Its target-changed and source-replaced branches reject after comparison. The Web state and renderer fixtures exercise the explicit native-existing mapping, independent Environment selection, original directory inspection, complete differences and retained cancellation cleanup. See [native existing-directory integration](../../../../packages/organization-runtime/test/handoff-native-existing.test.ts), [Web state ownership](../../../../apps/web/test/organization/handoff-native-existing-state.test.ts) and [rendered handoff flow](../../../../apps/web/test/organization/handoff.browser.test.ts).

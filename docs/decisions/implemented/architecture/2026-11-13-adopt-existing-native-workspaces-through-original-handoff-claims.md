# Decision Record: Adopt existing native workspaces through original handoff claims

Status: implemented

## Problem

Returning a cloud-backed Session to a member does not establish which version of an existing native directory the member accepted. A captured file hash cannot replace current directory ownership, complete differences, or the final Session publication transaction. Cancellation can also overtake an accepted preview or native claim acquisition. The [nested release failure](../../../postmortem/0168-workspace-move-release-escaped-an-outer-transaction.md) demonstrates why physical release cannot join an enclosing SQL transaction.

## Decision

An explicit organization-to-native mapping selects an existing project Workspace, generation, catalog revision and project-selection revision. Initial mapping consent fixes its actual member actor. Source preparation freezes the original Session cohort and captures the current service subtree through the existing Workspace archive and portable file owners. It retains no native claim for a pathless remote Locator.

The target verifies the complete staged cohort before reserving its original inactive Epoch. The same WorkspaceMove intent compares the verified source graph with a real native capture, including Git metadata, ignored and untracked files, removals, modes and links. Its derived SQL index pages headers without re-reading bodies. A new target capture replaces the previous derived index through the original Move transaction. Second consent binds the mapping revision and exact source snapshot, target digest and difference hash. Source-head, project-selection, catalog or physical changes block preparation or publication and require review.

Adoption selects the target directory's version; it does not overwrite either tree. Native preparation retains the original durable Workspace claim and complete receipt. The actual Core/catalog/Epoch transaction records the same Move's native publication hash and installs its synchronous physical, signal and lifetime guards. Release runs outside SQL. Its actual terminal commit closes accepted publication admission before draining the original job and confirming physical release, including unknown acknowledgements through the original identity. Published native effects cannot become a cancellation outcome.

Cancellation drains accepted preview or preparation work, permanently marks the actual inactive target Epochs never-activate, and releases the original Move before returning its corresponding signed target fact. A preview release does not claim a prepared hash. An unacknowledged local preparation uses that same inactive retirement path. Source cancellation remains a separate canonical fact.

Handoff storage reader three upgrades readers one and two through registered owner migrations. Target receipts use reader two with a strict reader-one upgrade. WorkspaceMove reader two preserves object request hashes and version-one receipt output. New native mappings require handoff protocol reader five; history grants no allocation, execution or publication authority.

## Alternatives considered

**Copy into a fresh directory.** This preserves a useful independent legacy operation but cannot represent acceptance of the existing target's version.

**Publish first and retain differences afterward.** This loses the member's exact second consent and permits stale target publication.

**Add a parallel native coordinator or cancellation ledger.** This duplicates the existing Move, Epoch and Handoff authorities.

**Release from an enclosing SQL callback or an after-commit notification.** This can release a physical claim before rollback or hide a committed unknown result.

## Consequences

The original native directory, cloud bytes and paused Session identity remain independently verifiable. Tests cover complete TLS return, strict consent hashes, source-head changes, held preview and claim acquisition, prepared cancellation, both publication/cancellation commit orders, lost terminal acknowledgement and outer-transaction rollback. See [Workspace ownership](../../../architecture/workspace-and-files.md) and [organization handoff](../../../architecture/organization.md).

This unit supports cloud-object to existing-native adoption. Explicit downloads, native-to-native existing-directory transfers, remote compute and independent Continue remain separate work. Default keep-cloud behavior and legacy fresh private copies retain their own semantics. Main's complete handoff capability remains closed. Machine receipts use [immutable acknowledgements and limited cleanup inspection](../bug-fix/2026-11-13-acknowledge-only-original-handoff-machine-facts.md); account or device revocation recovery remains separate.

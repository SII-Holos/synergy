# Decision Record: Review native directory versions before handoff

Status: implemented

## Problem

The native handoff owner supports adopting an existing destination directory. Treating it as the legacy private-copy choice would hide which files the member accepts. The comparison becomes meaningful after the source freezes, and initial mapping consent does not establish acceptance of that later comparison. Source cancellation also leaves a separate target preparation lifetime.

## Decision

The existing Move conversation dialog offers native adoption only when the generated preflight returns that exact choice, a cloud source and an actual destination project directory. Selection preserves its workspace, generation, catalog revision and project-selection revision. The UI uses the inspected label and does not create a path, infer an unregistered directory or allocate resources. The cloud source and existing native directory retain their files; adoption uses the destination's versions.

The member first accepts that directory mapping. Source preparation then freezes the final source through the existing owner. Only afterward can the destination issue `preview-target`. Preview remains separate from native preparation. Unknown preview results retain the original request and reconcile through target inspection.

A separate bounded reader requests actual difference pages through generated `inspect-target`, using the comparison's `diffHash` as `expectedRevision`. Machine-result revision is a proof hash and cannot substitute for it. The reader retains one page of at most 64 headers and cursor metadata for navigation. Pages keep exact paths, kinds, modes, hashes and links, including Git, ignored and untracked content represented by the owning capture. Root-directory modes remain visible even when no file entry differs. Changed comparison identities, incomplete page counts and foreign cursors cannot silently enter the current reader.

The complete comparison and its counts are established by the native owner's sealed difference. The interface does not require clicking through thousands of pages or claim every file has been read. After a real current page loads, the user explicitly acknowledges the differences they need to review and then confirms adopting the destination versions. Full version identities remain in a collapsed disclosure. The second generated acceptance request binds the exact source snapshot hash, target digest, difference hash, mapping revision and original mapping hash. Initial `targetAccepted` cannot acknowledge this second request; native preparation remains unavailable until the canonical difference-accepted field confirms it.

Source cancellation does not complete an unknown target preview or release its physical preparation. The existing connection-owned recovery record can retain an original native cleanup handle: immutable handoff binding, frozen manifest and the actual destination Runtime registration. Original pending bodies remain intact. The handle is metadata, contains no signed authorization or credentials, and cannot grant remote authority.

The known-handle cleanup entry uses generated `inspect-target` directly. It does not first refresh a Session or call the Session-dependent handoff list. It remains separate from project execution permission and checks the original active destination member, key and deployment. Returned cleanup data must contain only the matching target's limited facts; differences, object data, requirements and foreign bindings are rejected. Only the original target's never-activate or preview-released fact establishes cleanup completion and can retire its retained unknown preparation. The check never retires a target, opens a private Session, starts a Runtime or sends Continue.

Each reader and confirmation retains the original Space, handoff and comparison generation. Replaced or cancelled reads cannot populate a successor. Confirmation captures the exact comparison rather than re-reading a later mutable view. Focus returns through the owning dialog's stable control. Completed adoption leaves the destination paused and retains ordinary independent Continue.

## Alternatives considered

**Treat existing-directory adoption as a fresh copy.** This changes file semantics and loses explicit acceptance of target versions.

**Consent to the preflight tree.** Source files can change before the final freeze, so preflight cannot establish the final comparison.

**Accumulate all difference bodies or require visiting every page.** Both scale with total directory size without adding native authority. Bounded on-demand pages and explicit review preserve complete owner-established identities.

**Use a cancellation flag as target cleanup proof.** It cannot establish native job drainage, a permanent inactive-epoch tombstone or physical release.

## Consequences

The implementation reuses the original handoff, WorkspaceMove, native publication and cleanup contracts described in [native adoption](../architecture/2026-11-13-adopt-existing-native-workspaces-through-original-handoff-claims.md). The frontend's protocol fixtures and isolated headless transport verify presentation and coordination; they do not replace real TLS/native acceptance or establish full HAND capability. Downloads, native-to-native directory adoption, compute and full recovery remain separate owner work.

The current cleanup entry requires an already retained handle or readable handoff history. Runtime-management rediscovery and revoked-device recovery use their separate authenticated backend contracts and are not synthesized from Session data. The [integrated Environment and Workspace handoff](../architecture/2026-11-14-bind-logical-environment-mapping-to-native-handoff.md) supplies the public controller; directory comparison does not grant execution or revoked-machine recovery authority.

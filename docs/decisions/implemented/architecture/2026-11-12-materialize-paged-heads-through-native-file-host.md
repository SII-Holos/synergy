# Decision Record: Materialize paged heads through the native FileHost

Status: implemented

## Problem

The execution host accepted only complete legacy manifests for materialized mounts and imports. A valid paged saved head failed at that consumer. A pending mount also needed evidence of the directory it had actually prepared: matching bytes alone could adopt a foreign directory after an uncertain publication. A final path check followed by an ordinary rename could replace a competing empty directory.

## Decision

`NativeWorkspaceFiles` selects the owning legacy manifest or portable root schema from the saved descriptor and retains the original blob methods. Paged mounts use `NativeWorkspacePortableTree.materialize`; paged imports enumerate the canonical indexed headers, validate each destination through `WorkspaceTree.importHeader`, then materialize privately before the existing retained mutation copies its single `entry` subtree. The consumer never rebuilds complete entry or per-file chunk arrays. Legacy manifests remain explicit input to their existing materializer.

The host snapshots its directory settings and numeric native owner values before asynchronous work. Both native materializers bind their original blob methods, cancellation, owner and publication callback at entry. Ownership is applied to private files, directories and literal links before their final permission and durability checks. A successful materialization requires the complete graph, content hashes and filesystem checks; metadata indexing alone cannot authorize success.

Both materializers expose a narrow trusted `beforePublish(stagedPath)` callback after verification, ownership and synchronization but before native publication. The mount owner records that staged directory's physical identity in its existing input-digest-bound pending receipt. A cold retry with a final directory requires the same prepared identity and verifies its complete content. Equal bytes in another directory cannot supply the missing native receipt. An older pending receipt without that identity remains unresolved when a final directory exists; an absent final directory permits a new preparation under the original request. Completed mounts retain their existing physical-identity checks and may contain later legitimate edits.

Final publication reuses `FileRename.exclusive`, the existing platform-native no-replace directory operation. The destination must be absent, including when an existing directory is empty. Materialization does not own directory retirement: removing a previously observed empty directory could delete a foreign replacement before publication. Existing producers already select absent private destinations. Final identity checks, original cancellation, directory synchronization and the original preparation receipt remain. An acknowledgement lost after actual publication leaves the pending original receipt available for cold reconciliation.

The host rechecks the final directory's identity against the same prepared receipt after the materializer returns, before completing the mount. A replacement during the publisher's final directory synchronization cannot become the completed mount's native identity. A later replacement leaves a receipt referring only to its original directory and fails normal required-mount checks.

## Alternatives considered

**Rebuild a complete manifest from portable pages.** This would retain the old growing arrays and duplicate the page decoder in the execution host.

**Adopt an existing final directory after a matching content hash.** Equal content does not prove that the current request prepared that native object. The pending receipt must retain the original physical identity.

**Add another directory publisher.** The native no-replace operation already serves file and directory publication on supported platforms. An ordinary rename fallback would reintroduce the empty-destination replacement race.

## Consequences

Native mount and import consumers accept both saved-head formats while preserving the original file ownership, mutation receipts, cold recovery and shutdown drainage. The [default producer decision](2026-11-12-write-paged-workspace-heads-through-indexed-chunks.md) advances checkpoint and file-import production after save and preservation consumers accept the complete paged graph. The optional preparation identity is additive, but older ambiguous pending native mounts require explicit recovery instead of inferred adoption.

## Verification

`test/workspace/file-host-paged.test.ts` materializes and imports a real saved head spanning multiple pages after deleting all original native files and blob objects. It checks binary bytes, empty directories, literal links, executable mode and native ownership, then reopens the FileHost from its original receipts. Controlled native publication verifies lost acknowledgements, equal-content replacement, missing legacy preparation evidence and rejection of a competing empty destination. Held blob reads verify original ports/options and shutdown drainage; missing immutable bytes leave no completed mount or published directory. The existing FileHost and native tree suites retain mutation retry, explicit-mode uncertainty, ranges and corrupt-content coverage. The [publication postmortem](../../../postmortem/0126-native-materialization-replaced-a-competing-directory.md) records the actual race.

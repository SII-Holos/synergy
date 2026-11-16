# Decision Record: Read selected Workspace files through paged indexes

Status: implemented

## Problem

Portable Workspace files use bounded metadata pages and content references, while the ordinary object-file reader and Local Runtime file facade expected one array manifest. A valid paged saved head could not be browsed or read through those product operations. Expanding it into a full content tree would reintroduce the same metadata and memory limits.

## Decision

`WorkspaceContent.withTree` owns a callback-bound metadata reader for a captured immutable head. Paged heads use the canonical `WorkspacePortableTree` disk index; bounded historical array manifests use one adapter with the same entry, link, prefix and content operations. Manifest metadata remains in the Runtime's bounded content-addressed cache. Each paged callback owns and removes its temporary index; no cache grants binding or execution authority.

The reader snapshots its original blob methods and cancellation. It verifies the original Runtime, primary handle, Store options and artifact configuration before and after asynchronous operations. Closing the callback retires escaped readers and iterators, waits for accepted underlying body I/O, and then disposes the index. A delayed result cannot escape after cancellation, closure or namespace substitution. This is a read lifetime, not permission to run producers or mutate the Workspace.

`WorkspaceContent.read` and `readRange`, and Local Runtime's `FileView` canonical/stat/list/observe/bytes paths, use this owner. File metadata does not fetch unrelated bodies. Full reads verify the file digest; ranges verify selected chunks and preserve bounded output. A multi-chunk FileView read and its observation use one captured tree rather than reopening the index for each chunk. Contained links retain logical display paths and resolve through the same canonical metadata owner.

Entry versions derive from canonical path/kind/mode/content metadata and the catalog revision, independent of chunk representation. Persisted original operation requests and receipts are unchanged. A client holding an older opaque entry version may receive a conflict and must reread; it cannot gain mutation authority from a version conversion.

Range endpoints are clipped to available file bytes before adding lengths. Individually valid safe integers beyond EOF produce an empty range without body reads, instead of overflowing during addition. Caller range objects are copied before asynchronous selection.

## Alternatives considered

**Materialize every portable entry in memory.** It would restore array-manifest limits and defeat the bounded metadata representation.

**Add a second cloud tree format.** The existing portable codec already owns path validation, chunk references, page totals and integrity checks.

**Reopen an index for each file chunk.** That repeats complete metadata indexing within one user read and can mix separately observed heads.

## Consequences

Product reads can consume paged saved heads without allocating compute or fetching unrelated file bodies. This unit does not migrate current writers, archive/mount/Snapshot producers or WorkspaceMove publication. Those owners must complete their own paged write and migration paths before complete handoff is enabled. The bounded legacy writer remains explicit and cannot write a paged head through the old array API.

## Verification

`packages/harness/test/workspace/content-paged.test.ts` verifies more than one metadata page, contained links, selected-body-only reads, binding rejection, actual held body cancellation, foreign Runtime/artifact/namespace rejection, expired iterators and drainage before callback completion. Native namespace substitution and early completion first reproduced incorrect acceptance. `test/workspace/content.test.ts` retains array-manifest operations and adds the beyond-EOF range case. The range case first reproduced safe-integer overflow in the indexed reader.

`packages/local-runtime/test/workspace-file/paged-view.test.ts` exercises actual selected object resources with nested paths, links, browsing, observations, revalidation, a 9MB file, multi-chunk ranges, original selectors and zero Environment allocation. The existing selected-view suite retains native mounted and bounded object edits. Portable metadata and stream index suites verify malformed graphs and chunk integrity separately.

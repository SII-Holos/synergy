# Decision Record: Consume cross-Realm WorkspaceMove receipts before paused handoff

Status: implemented

## Problem

A verified native file closure proves source bytes, but cannot prove publication into an organization object Workspace. The handoff mapping must bind a concrete destination, its revision and the authenticated selector; the paused destination must consume the complete canonical CAS receipt rather than accepting a nullable receipt hash or reconstructing a local copy of the cloud head.

## Decision

The existing handoff stores a versioned native or organization-object mapping. Object mappings bind the move ID, exact source Workspace generation, service resource/Workspace/generation, subtree, expected head revision and null difference acceptance. Destination consent binds the complete mapping hash and mapping revision. The original authenticated selector owns resource selection; accepting the unchanged mapping does not make the recipient a new selector. Both member participants retain independent current project execution and machine ownership checks. The service rechecks the original selector's current resource permission through canonical authorization, including inside the actual WorkspaceMove publication transaction.

The source captures final files inside its existing physical handoff callback. A finite read-only graph port verifies the original native capture receipt and supplies the canonical Archive copier. Signed machine operations upload immutable objects and invoke the one registered captured-source port of WorkspaceMove. The original move owns reservations, whole-head CAS, subtree verification, publication uncertainty and the receipt; no second phase ledger or tree decoder is introduced. The source's organization transfer record retains the exact dispatched descriptor and confirmed receipt. An uncertain publication can only inspect that same intent; it cannot recapture different bytes or submit another publication. Terminal handoff facts release the same move outside SQL, after accepted work drains, and never undo or delete a published directory.

Organization portability reader 4 exports the complete WorkspaceMove receipt in its root header. Reader 3 remains an explicit native-history input; it cannot supply an object mapping receipt. The target verifies that header against the frozen hash, the canonical source graph and a fresh service validation of the same original request. The existing Workspace portability owner prepares and publishes a separate local Locator with the remote resource, Workspace, generation and consented subtree, without local content or native mount authority. The Locator, canonical Session and native epochs publish together and remain paused. The service changes the Session resource contract in the existing handoff commit transaction, retaining its exact pre-mapping selection for independent continuation validation. Permanent target retirement writes the existing never-activate epochs and fact atomically.

The registered organization file source supplies ordinary file tools with a finite remote FileHost lease under their actual native Session/root/Run/tool origin. One accepted member-resolution callback retains the original accepted root, connection, proof and fixed FileReference. [Child-origin validation](../bug-fix/2026-11-12-retain-child-file-origins-beside-ancestor-grants.md) preserves a Cortex child’s own root/Run/tool separately from its verified ancestor grant. Logical Locator identities are translated independently from service Workspace identities. A signed optional rootPath restricts canonical reads within the same service tree and mutations under the original whole-head CAS, including symlink resolution. A changed head requires a new explicit operation; uncertain writes retain their original ID, body and revision. Cold operation recovery reopens only receipt/acknowledgement access through original native reception evidence and the existing WorkspaceOperations record. It never binds or reacquires execution. Confirmed no-effect conflicts become failed operations; transport uncertainty remains unknown.

Optional aggregate owners seal only after every exact source epoch is frozen, using the original ordered cohort cursor. Evidence uses this contribution to seal its existing dependency set before stream export; the source controller does not enumerate another cohort or hardcode optional owners.

## Alternatives considered

**Treat the source file digest as a publication receipt.** It cannot establish destination CAS, range ownership or the final subtree. The complete canonical receipt remains a separate fact.

**Copy the service head into the destination Runtime or create a native mirror.** This would establish competing heads and native authority. A remote Locator delegates each operation to the one service owner.

**Reissue an uncertain upload with a refreshed head or a new move ID.** This can duplicate publication or replace the originally accepted destination. Inspection retains the exact original request and descriptor.

**Require every recipient to have personal resource selection permission.** That changes unchanged-mapping consent into a new selection and breaks Session collaboration. Resource permission belongs to the actual selector; participant project execution and Runtime ownership remain independently checked.

## Consequences

The opt-in listening Runtime composition supports native-to-organization-object transfer into a new subtree, complete receipt consumption, cancellation without deletion, and permanent destination retirement. [Default keep-cloud return](2026-11-12-retain-live-workspaces-through-return-handoff.md) captures the current service files separately. Existing-directory difference adoption, additional current Working locations, cloud compute and automatic Continue remain separate owners. Generic Host/HTTP origins without actual Session execution provenance cannot open the organization file source. The explicit Session file API remains independently available. Main's overall handoff capability stays disabled until complete bidirectional product acceptance.

## Verification

`organization-runtime/test/handoff-cloud-workspace.test.ts` uses two enrolled listening Runtimes and real TLS service storage. It verifies one service head CAS, binary and ignored files, complete streamed receipts, paused remote-only publication, same-ID inspection after a lost publish reply, cancellation without undo, permanent retirement, original-selector revocation and a different recipient with no personal storage grant. `test/workspace-files.test.ts` uses actual native Run/tool evidence and ordinary file tools, a cold Runtime receipt reconciliation without write replay, stale CAS failures and service-enforced mapped-directory symlink confinement. Protocol signature tests bind the full operation, mapping, source descriptor and rootPath. Existing native WorkspaceMove, source/target controller and aggregate-owner suites retain their original behavior.

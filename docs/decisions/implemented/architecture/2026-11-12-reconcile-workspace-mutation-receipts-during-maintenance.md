# Decision Record: Reconcile Workspace mutation receipts during maintenance

Status: implemented

## Problem

Stopping Agent admission does not stop independent file requests. A new Workspace write could stage bytes and publish its head while maintenance drained. Existing requests could still upload immutable content after drainage had reported completion. A lost file-write acknowledgement also leaves an original mutation and resource use requiring reconciliation rather than a new write.

## Decision

`WorkspaceOperations` contributes its native request and receipt owner to Runtime maintenance. New writes and mutations check admission before staging or external dispatch and again in the canonical publishing transaction. An already accepted logical ID is checked first and follows its original receipt; maintenance does not make accepted results unreadable. A preparation that has not published its admission cannot publish a new head after the hold begins.

Drainage waits for the actual serialized request promises and supports cancellation of that wait. It then walks the canonical active index in bounded pages, validates each key and operation identity, and reconciles its original mutation, checkpoint, evidence, acknowledgement and use release. A missing external receipt remains unknown and blocks freezing. The owner never changes the logical ID or treats unknown as permission to submit a replacement mutation. Inspection retains bounded reconciliation reasons rather than collecting historical requests.

This owner neither allocates new compute nor changes the general `Environment.acquire()` contract used by accepted final saves. It operates during the native draining phase; the final frozen guard still rejects ordinary canonical mutations. Source release does not replay file requests.

## Alternatives considered

**Freeze as soon as the Agent becomes idle.** Independent uploads and file-save requests have different lifetimes and can still publish their canonical head.

**Reject every repeated request while maintenance holds admission.** Existing logical receipts are the safe way to observe uncertain results without replacing an accepted mutation.

**Retry a missing file receipt with a new mutation ID.** The first effect may already exist. A new ID can duplicate effects and lose the original checkpoint and resource-use identity.

## Consequences

An unadmitted immutable preparation may finish staging but is refused at publication; it cannot change the Workspace head. An accepted mounted mutation instead completes its original saving and release path. Unknown receipts and damaged active indexes leave maintenance held.

This contribution covers Workspace operation requests and their native receipts. It does not close every raw Workspace claim or mount transition, capture every live resource view, provide per-Session handoff provenance or establish complete deployment recovery. Those owners and the physical writer cohort remain separate required integrations.

## Verification

Harness `test/workspace/maintenance.test.ts` first reproduces admission of a new write and premature drainage of a blocked upload. Temporary SQLite and actual immutable bytes verify exact accepted-result retries, no new staging after the hold, waiting for preparation and rejection of its unadmitted head at the final transaction.

Local Runtime `test/workspace/maintenance.test.ts` uses the real native provider, directory view, file bytes and Workspace coordinator. It loses the response after the original file mutation succeeds, then verifies that maintenance saves and releases the original receipt with exactly one physical write. Hiding that receipt leaves the operation unknown and held until the original evidence becomes available; neither attempt replays the file mutation.

## Related

- [Workspace and files](../../../architecture/workspace-and-files.md)
- [Purpose-bound maintenance](2026-11-11-retain-purpose-bound-runtime-maintenance-holds.md)
- [Native process maintenance](2026-11-12-drain-native-process-ownership-for-maintenance.md)

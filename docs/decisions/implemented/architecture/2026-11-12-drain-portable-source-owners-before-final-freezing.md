# Decision Record: Drain portable source owners before final freezing

Status: implemented

## Problem

Individual owner and epoch operations do not establish a safe source preparation order. Freezing a parent before its child finishes native continuation or Inbox writes rejects legitimate drainage. A child created during drainage can also start before the controller enumerates it, or be omitted between the last scan and the final parent fence. A single command watermark check permits commands admitted during preparation to escape the frozen package.

## Decision

The public `SessionTransferSource` preparation operation pauses the original root, retains its canonical draining intent and discovers native children and registered owner dependencies through a temporary indexed cohort. It acquires each member's existing epoch hold before owner drainage. Native owner suspension precedes the Core idle check. After drainage, discovery repeats until no new member appears. Domain freeze operations preserve identity and must reconcile a repeated call for the same exact draining or frozen handoff; a new handoff cannot borrow a prior hold.

Scheduling admission follows canonical parent links as well as explicit aggregate bindings. A newly created descendant therefore inherits its draining ancestor's hold immediately. The mutation path continues permitting legitimate drainage writes until the final fence. The recursion tracks the active ancestry path, so a shared parent/root dependency is not mistaken for a cycle.

Final member freezing follows native child-to-root order. Each epoch transaction checks its current child metadata inventory: every child must be in the cohort and already frozen for this handoff. The root also rechecks its command barrier in that same transaction. A newly discovered member or changed watermark leaves the source held and unprepared; preparation never automatically resumes or repeats work. The frozen native graph passes the same Core aggregate validator used by destination preparation before streamed export. All member ledgers then bind the same complete package hash. A separately persisted source cache permits immutable result reconciliation; it neither replaces the epoch authority nor grants execution.

Cohort enumeration, parent order and closure checks use bounded SQL caches and seekable rows rather than an aggregate-sized JavaScript collection. Temporary indexes are removed on success or failure. Per-member recovery records remain available after failure, while only a complete sealed source package is returned by status.

## Alternatives considered

**Freeze the root before processing children.** This prevents valid native child completion from updating its parent and can lose the original continuation identity if callers work around the rejection by cancellation.

**Take one child snapshot and check only transport hashes.** A real child can appear after that snapshot; exact checksums over the remaining package do not prove complete membership.

**Automatically cancel the preparation after an unknown result.** Source drainage may already have taken effect. Releasing its gate would race destination preparation and physical operations whose outcomes require reconciliation.

## Consequences

Real native fixtures retain queued Cortex identity, allow drainage tail writes, include late native children, reject a final membership race and leave a changed command barrier paused without a package. Existing Cortex Continue and permanent epoch cases remain independent regression checks. This source operation supplies canonical aggregate preparation; organization machine dispatch, signed proof publication, physical Environment/Workspace drainage and target binding adoption remain separate integrations. Completion of this operation alone does not establish an end-to-end organization handoff.

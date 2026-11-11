# Decision Record: Drain portable source owners before final freezing

Status: implemented

## Problem

Individual owner and epoch operations do not establish a safe source preparation order. Freezing a parent before its child finishes native continuation or Inbox writes rejects legitimate drainage. A child created during drainage can also start before the controller enumerates it, or be omitted between the last scan and the final parent fence. A single command watermark check permits commands admitted during preparation to escape the frozen package.

## Decision

The public `SessionTransferSource` preparation operation latches the original root's pause, retains its canonical draining intent and discovers native children and registered owner dependencies through a temporary indexed cohort. It acquires each member's existing epoch hold before owner drainage. Domain suspension follows native child-to-root order, before ordinary parent turns receive their pause abort. This protects the child from the synchronous TaskTool's ordinary cancellation callback. Core then awaits native idle and both bound and detached loop recording before its final idle check. After drainage, discovery repeats until no new member appears. Domain freeze operations preserve identity and must reconcile a repeated call for the same exact draining or frozen handoff; a new handoff cannot borrow a prior hold.

Scheduling admission follows canonical parent links as well as explicit aggregate bindings. A newly created descendant therefore inherits its draining ancestor's hold immediately. The mutation path continues permitting legitimate drainage writes until the final fence. The recursion tracks the active ancestry path, so a shared parent/root dependency is not mistaken for a cycle.

Source preparation opens the native LoopJob recording capture before pausing. Its asynchronous lineage predicate includes descendants not yet enumerated in the cohort while excluding unrelated roots. Captured failures remain in the same native failure entries, including when ordinary turn settlement observes them. Core uses a non-consuming snapshot drain, so a failed preparation cannot pass on retry merely because the first attempt consumed its error. Cancelling the wait leaves the original recording job and source hold intact. Capture disposal drains pending lineage checks; retained errors last for that Runtime's lifetime and do not establish cold physical-writer reconciliation.

Final member freezing follows native child-to-root order. Each epoch transaction checks its current child metadata inventory: every child must be in the cohort and already frozen for this handoff. The root also rechecks its command barrier in that same transaction. A newly discovered member or changed watermark leaves the source held and unprepared; preparation never automatically resumes or repeats work. The frozen native graph passes the same Core aggregate validator used by destination preparation before streamed export. All member ledgers then bind the same complete package hash. A separately persisted source cache permits immutable result reconciliation; it neither replaces the epoch authority nor grants execution.

Cohort enumeration, parent order and closure checks use bounded SQL caches and seekable rows rather than an aggregate-sized JavaScript collection. Temporary indexes are removed on success or failure. Per-member recovery records remain available after failure, while only a complete sealed source package is returned by status.

New root and child intents publish their source member record through the epoch owner's transaction, after acquiring its native locks. A failed member write therefore rolls back the intent and allocation together. The callback composes record publication and cannot perform external effects.

`SessionTransferSource.cancel()` first completes that same native discovery and drainage, stopping before final freezing or export when no package exists. This also repairs an older member index interrupted after its epoch intent was committed. Under the source lock, it rechecks the command barrier, canonical descendant membership and the paused root, then cancels every member epoch and writes its versioned operation receipt in one transaction. Any surrendered member or failed receipt publication rolls back that transaction. Cached receipt reads check the exact binding and permanently cancelled root without rescanning an immutable historical cohort; the receipt can only be published with the complete cancellation. Cancellation preserves native task holds and pause and never requests Continue.

## Alternatives considered

**Freeze the root before processing children.** This prevents valid native child completion from updating its parent and can lose the original continuation identity if callers work around the rejection by cancellation.

**Abort the parent before acquiring native child holds.** Its real TaskTool callback can cancel the recorded delegation. Latching a pause does not itself establish a child suspension proof; native holds must precede the parent's abort event.

**Take one child snapshot and check only transport hashes.** A real child can appear after that snapshot; exact checksums over the remaining package do not prove complete membership.

**Automatically cancel the preparation after an unknown result.** Source drainage may already have taken effect. Releasing its gate would race destination preparation and physical operations whose outcomes require reconciliation.

**Use ordinary turn settlement as a snapshot drain.** Ordinary settlement consumes its recording failures. A second preparation could then seal incomplete evidence, and a concurrent settlement could hide a child's failure before discovery. Native capture preserves that existing error instead of adding a competing persistent error store.

**Cancel only the root or the first saved member index.** A crash can leave a child's committed intent without its source index row. Repairing the native cohort before the atomic cancellation prevents a hidden hold from being stranded behind an apparently cancelled root.

## Consequences

Cancellation fixtures fail a source member-index write and verify the child's intent rolls back. They then seed an older partial intent, fail the final cancellation receipt and verify rollback of all epoch changes. Successful retry and cold reopening retain the same complete result. A surrendered child prevents release of the remaining frozen root. The actual TaskTool/provider fixture also invokes cancellation directly, preserving its original task, root and hold with no package or extra provider call. See `test/session/transfer-source-cancel.test.ts` and `test/session/transfer-source-task.test.ts`.

Every member's Core idle and recording tails drain before the optional external `beforeFreeze()` preparation callback runs. That callback runs outside a SQL write transaction and before any member's final epoch fence, allowing the physical owner to finish native claim drainage and immutable file capture. The command barrier is rechecked afterward; owner receipts and child-before-parent final epoch validation remain independent. A rejected preparation leaves the source held without exporting a package. Retained completed candidates reconcile through their existing path, so callers must separately revalidate their physical lease when inspecting an existing package. `test/session/transfer-source-physical.test.ts` exercises real root and child recording jobs, failed physical preparation, exact retry and the SQL boundary; it does not supply physical writer proof itself.

Real native fixtures retain queued Cortex identity, allow drainage tail writes, include late native children, reject a final membership race and leave a changed command barrier paused without a package. A real parent invocation, synchronous TaskTool and blocking child provider additionally prove that the child already holds the exact transfer at the parent abort event, with original task/root identity and one provider invocation on each side. Core waits for native post-turn recording tails. Existing Cortex Continue and permanent epoch cases remain independent regression checks. This source operation supplies canonical aggregate preparation; organization machine dispatch, signed proof publication, physical Environment/Workspace drainage and target binding adoption remain separate integrations. Completion of this operation alone does not establish an end-to-end organization handoff.

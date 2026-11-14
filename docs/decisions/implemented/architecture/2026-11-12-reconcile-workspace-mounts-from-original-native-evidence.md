# Decision Record: Reconcile Workspace mounts from original native evidence

Status: implemented

## Problem

An existing ready Environment can admit a mount after maintenance starts. Detachment can publish `saving` before a later physical gate rejects it. In-memory transition maps also disappear after an uncertain response, so an empty map cannot certify completion. Treating an orphaned `preparing` record as authority to materialize again can replace an unavailable live view with an earlier head.

## Decision

Harness registers one `workspace-mounts` maintenance owner. New attach/detach intents check canonical admission before resource use and again in their intent transaction. Actual admitted transition promises drain without cancellation or replay. Cancellation ends only the maintenance wait; an already running native transition keeps its identity and can finish its original publication.

Explicit maintenance reads native transition indexes in bounded windows and verifies each exact Workspace, Scope and Environment identity. A separate bounded canonical catalog walk detects absent index coverage. Preparing, saving and unavailable states remain blocking requirements unless the original native mount receipt proves the exact preparing view. Reconciliation validates the mount ID, Workspace, generation, allocation target and canonical state before publishing the original path and releasing its original use. It does not call materialization again.

Only the request that publishes a fresh preparing intent can begin its first materialization. A later orphaned preparation with no native receipt stays unavailable instead of recreating an earlier head. A resolved native receipt can finish a lost acknowledgement. Ordinary attachment cannot reopen a saving or unavailable view, and final publication cannot overwrite a concurrently changed transition. Uncertain intent commits preserve their retained resource use.

## Consequences

The existing canonical mount and Environment use records retain durable authority; no parallel transition state or startup backfill is added. Maintenance performs its catalog coverage walk only during the explicit operation. Stable active views still need the complete operator's resource capture and physical writer proof. This owner does not detach them automatically, freeze an external volume or authorize restored execution. Unknown saves and missing native evidence require their owning recovery path.

## Alternatives considered

**Check only the pending promise maps.** They omit retained canonical transitions after a response loss or restart.

**Replay attachment from a preparing row.** That row does not prove the original live view exists or authorize replacement from an older content head.

**Trust the native index without catalog coverage.** A missing row could hide an active canonical mount from the maintenance proof.

**Block all lower Environment acquisition.** Original mutation acknowledgements and accepted final saves still require that owner.

## Verification

Real Local Runtime/SQLite/file-host fixtures first reproduce new attach during a hold, half-published detach, premature maintenance drainage, orphan rematerialization and a committed mount remaining preparing after an acknowledgement loss. Additional counterexamples expose reopening a pending save and falsely accepting missing index coverage. The repaired cases preserve original IDs/generations, stop cancelled waits with the original reason and never repeat materialization. Native Workspace mutation, binding replacement, Environment lifecycle and remount migration suites remain selected. These checks do not establish complete deployment backup or external-volume recovery.

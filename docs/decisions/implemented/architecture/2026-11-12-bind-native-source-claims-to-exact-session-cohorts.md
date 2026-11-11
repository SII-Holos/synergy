# Decision Record: Bind native source claims to exact Session cohorts

Status: implemented

## Problem

A canonical Session epoch could stop scheduled execution while a direct Workspace operation still admitted physical writes. Temporary exclusivity around one directory capture expired before final epoch publication. An empty resident claim set also omitted older retained native writers and process output that continued after exit.

## Decision

Workspace admission consults the owning Session transfer gate through a Runtime-composed interface. New root and descendant claims fail from the canonical source intent onward, including claims whose native acquisition crosses that intent. Accepted native claim tails consult the owning mutation contract in its write transaction: drainage remains possible, while a final frozen or surrendered epoch stays immutable. Maintenance retains its independent admission and mutation rules.

The native process preparation entry uses that same actual claim context before starting its supervised process. A new Session start cannot bypass the transfer gate by supplying a raw coordinator lease; an original native writer can still finish its helper through its retained capability. Physical drainage waits for native completion before claim settlement and rechecks completion after finalizers.

The Local Runtime's `NativeSessionTransferPhysical` port requires the exact canonical root preparation binding and opaque evidence from the actual installed server lock. That evidence belongs to the original Runtime and primary Store, checks the original token and process start identity during physical preparation, and expires when native ownership releases. Standalone Store locks keep their existing API without acquiring installed Runtime authority. A synchronous assertion checks only this established capability's current local lifetime; final SQL still rechecks the canonical binding and command barrier.

Physical capture builds a bounded-page disk index from `SessionTransferSource.members()`, validates canonical ancestry and Workspace references, and drains the selected Sessions' actual process completion and Workspace finalizers. Process completion includes output and the original final receipt. Retained coordinator claims outside the current installed Runtime's acknowledged owners block capture. Canonical child membership, Workspace generation and physical paths are rechecked after drainage and capture.

One original native exclusive claim covers the selected physical root set through source publication. Parent roots cover nested Workspace paths; directory ancestry lookup handles intervening sibling prefixes without reserving a second conflicting claim. Each Workspace still requires its own canonical cohort membership and generation. Nested file capture borrows the retained claim through an open, Runtime/Store-bound callback; native parent-claim geometry rejects an escaped root. Borrowing pins its native lifetime before the first asynchronous check and through callback completion, so release cannot remove that ownership during either interval. A closing or failed claim cannot lend new authority. The capability survives the original acquisition Task, while the acquisition Task's completed cancellation scope cannot cancel a later accepted capture.

Retained native owner labels compare actual Home paths, including symbolic aliases, rather than trusting spelling alone. Source capture and Home maintenance reuse this matcher; unverifiable native Home origins cannot certify an empty current registry.

The lease's release operation releases physical resources only. It does not clear epochs, cancel tasks, resume execution or grant a destination writer. Source coordination must retain it through the required barrier, freeze and signed source facts, and release it during shutdown or failure cleanup. Cancellation stops waiting, preserves its reason and leaves accepted native writers and canonical source holds intact.

A failed capture cleans its original claims and private inventory before returning to a retryable phase. Failed cleanup retains the same releasing lease for reconciliation and preserves both original failures. It cannot allocate a new inventory over an unreconciled one.

## Alternatives considered

**Treat root pause or an empty resident process set as physical completion.** Native output and retained old claims can outlive both observations.

**Reserve the whole Home or infer ownership from Scope.** Independent Sessions can share a Scope and remote resources need their actual owning provider. The native port selects the persisted source cohort and canonical mounted roots.

**Permit arbitrary finalizer flags or reuse a closed Task.** The original native claim and its open callback provide concrete ownership and geometry; caller labels cannot supply that evidence.

## Consequences

Real coordinator and Source fixtures cover root/child admission, acquired-lease races, final-save drainage, retained unknown writers, independent parent/child Workspaces, output after process exit, cancellation and retry, late canonical children, callback escape and concurrent release. Installed writer tests cover foreign Runtime/Store, token replacement, closure and standalone Store compatibility. Ordinary process, Workspace and maintenance fixtures remain required neighbors.

Additional real counterexamples cover release during the borrower's native check and body, nested and interleaved-prefix Workspace roots, and retained writers using a symbolic Home alias. The complete cohort uses one native footprint, preserving the shared coordinator format and avoiding one ledger claim per selected Workspace.

Native acquisition consumes the same captured claim input that supplies retained geometry. A caller mutating its roots array during asynchronous admission cannot retarget the actual native claim while leaving a different recorded footprint.

This native resource port does not capture remote provider resources or authorize organization machine dispatch. The production controller and each resource owner must provide their respective binding, completion, package and current authorization evidence. Snapshot capture and Home backup maintenance remain separate owners.

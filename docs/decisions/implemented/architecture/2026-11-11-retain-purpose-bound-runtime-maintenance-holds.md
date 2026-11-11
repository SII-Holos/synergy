# Decision Record: Retain purpose-bound Runtime maintenance holds

Status: implemented

## Problem

Connection closure does not prove Agent, tool, process or Environment writers stopped. Runtime shutdown also cancels Cortex descendants, so it cannot serve as a backup pause that preserves their continuation identity. A lost acknowledgement or Runtime restart must not silently discard a maintenance operation and reopen execution.

## Decision

Harness owns one purpose-bound Runtime maintenance operation over its current native Storage Handle. This differs from the existing offline `StorageMaintenance` owner for opening, compacting and repairing storage formats. The operation records its backup/restore purpose, logical request, Host actor, writer-cohort contract, Runtime identity, phase and native tail revision. It never changes Session driver epochs or uses a handoff ID.

Selected native owners contribute ordered suspension, drainage, inspection and release methods before composition seals. Required missing owners or reported reconciliation requirements block progress. The maintenance owner issues opaque leases and drain receipts bound to the actual Runtime, Handle, operation and cohort. Callers cannot replace those proofs with booleans, copied objects or another Runtime's handle.

Draining admits native tail mutations while new admission remains held. Their tail revision commits with the actual canonical write. A mutation after owner drainage invalidates the old freeze receipt; a rolled-back mutation does not. Frozen operations reject ordinary canonical mutations. Only the maintenance owner can update its reserved records. Release keeps admission closed while owners finish and while any inspector reports unknown state. The operation retains its durable history after release.

Base Harness registration always installs the retained-operation mutation guard, even without a selected maintenance cohort. Native execution gates reject held operations; automatic and forced Session driving report no admission. New user Inbox writes recheck inside their canonical transaction while exact accepted-input retries remain readable. Continue checks before drainage and again in the recovery transaction, so a hold established during its wait cannot remove the original pause or reopen the root. Internal completion mail remains a native tail write during drainage.

The registered Session owner closes native scheduling admission after domain-specific suspension owners. It signals active leases with the existing paused-turn abort, then waits for their actual completion and lease release, including tail saves. It neither cancels the accepted root nor invents a pause latch for unattended Sessions. Inspection rejects remaining native leases. The LoopJob owner closes scheduling after those leases and completion hooks finish, then drains every tracked background run and pending payload, including detached jobs. It does not use shutdown cancellation. A cancelled wait retains both the operation and the accepted native work. Recording failures remain blocking across retries even when ordinary turn settlement consumes the error. Synchronous completion schedules check the retained namespace before executing native effects; ordinary loop execution uses its already checked asynchronous entry.

Owner `release` callbacks finish domain writes while global admission remains held. Optional `released` callbacks reopen native scheduling only after the canonical released phase is confirmed, while the Runtime remains ready. An uncertain final commit cannot invoke these callbacks; the same opaque lease reconciles the canonical phase and retries them without repeating domain release writes. Neither callback calls Continue, replays old input or resubmits job payloads. Process and Workspace drainage still require their own native owners; Environment contributes its separate completion and save checks.

Begin uses a stable native request/receipt identity. A committed operation with a lost acknowledgement remains held and reconciles the original operation on exact retry. Duplicate completed requests do not create a new hold. A cold Runtime cannot reuse the prior cohort's opaque lease or treat a repeated request as physical-writer reconciliation. Restore-purpose holds cannot use the source-backup release path.

## Alternatives considered

**Close the bridge or Runtime.** Bridge drainage only covers connection callbacks. Full Runtime close follows cancellation paths and can change delegated work instead of retaining a suspension.

**Reuse handoff IDs or set unattended Sessions paused.** These fabricate transfer authority or violate the canonical machine Session lifecycle. Maintenance has its own operation purpose and does not grant execution ownership.

**Accept a caller's ready flag.** It cannot prove actual owner drainage, detect a later native writer or survive uncertain commits and restart. Native operation participation and opaque receipts retain those boundaries.

## Consequences

The operation, admission guards and native Session owner do not themselves revoke every physical writer or implement whole deployment recovery. Production availability also requires actual Cortex/tool/process/Workspace/Environment owners, other physical admission paths, a hosted reader/cohort fence, controlled capture and native restore publication integration. A registered callback is not evidence that those production adapters are implemented. Unknown/cold operations remain held until their real owners reconcile them.

The primitive has no ordinary organization account route or administrator export permission. Runtime and resource authorization remain with their canonical owners; maintenance release cannot release a transfer hold or manufacture a current driver.

## Verification

Harness `test/storage/runtime-maintenance.test.ts` uses temporary SQLite and a real asynchronous canonical tail writer. It verifies admission/freeze boundaries, native mutation rollback, changed tail revisions, forged/cross-Runtime receipts, unknown writer requirements, failed release, a SQL commit whose acknowledgement is lost, exact retries, pre-cancellation and cold-cohort refusal. The existing offline `test/storage/maintenance.test.ts` remains unchanged and passes its original backup/worker-loss/progress contracts. These tests do not establish complete production writer drainage.

`test/storage/runtime-maintenance-restore.test.ts` captures a frozen source namespace and restores it into independent empty SQLite through the existing trusted portable importer. Finalization failure rolls back ordinary records and the retained operation together; retry restores protected records and binary content while ordinary writes and admission remain denied. The prior source lease cannot release the restored hold. This uses the native importer without disabling mutation guards or adding a new account-visible restoration privilege.

`test/session/runtime-maintenance.test.ts` exercises real Scope, Session, Inbox and continuation state. Held operations deny machine/forced execution and new input without losing accepted input. An explicit native-idle barrier admits maintenance after Continue starts; the publishing transaction retains the original paused root and no resume receipt. A separate Runtime registers only base Harness and refuses ordinary writes through the retained frozen operation. Neighboring Inbox, pause and recovery suites cover behavior when no maintenance operation is held.

`test/session/maintenance-owner.test.ts` runs a real native lease in an unattended Session with a materialized root. A paused-turn signal reaches the running lease; a tail-save barrier keeps maintenance draining until canonical storage commits and the lease releases. Freeze retains the same user root and no unattended pause latch. Releasing maintenance admits no new callback or deferred wake.

`test/session/loop-job-maintenance.test.ts` proves a real paused turn can schedule its completion job before LoopJob admission closes, that a detached canonical tail save delays drainage, and that cancelling the wait preserves the job and original cancellation reason. Release does not replay the job, another owner's held release cannot reopen its scheduler, and recording failures remain blocking after ordinary settlement. A fresh Runtime context using the same frozen namespace executes no deferred native effect. The storage suite also injects a lost acknowledgement after the actual released SQL commit and verifies exact-lease recovery without duplicate domain release writes.

## Related

- [Agent storage](../../../architecture/agent-storage.md)
- [Namespace checkpoints](2026-11-11-pin-portable-namespace-checkpoints-and-fence-restoration.md)
- [Organization recovery containers](2026-11-11-encrypt-organization-recovery-containers.md)

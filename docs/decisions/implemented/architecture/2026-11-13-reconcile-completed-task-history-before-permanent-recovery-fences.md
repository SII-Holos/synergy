# Decision Record: Reconcile completed task history before permanent recovery fences

Status: implemented

## Problem

A Hosted task can finish its model streams and native release while retaining service command, execution and gateway history outside the authority journal's policy projection. Restoring only current policy cannot certify or reconstruct those facts. Discovering an unsupported difference after permanently fencing either original writer leaves a known incomplete recovery. Live authorization also requires current connections and windows, which cannot validate an inert original signed receipt after deployment recovery.

## Decision

Command history consumes canonical request, attempt, watermark and index records through a typed read-only historical reader. It verifies original service signatures and accepted effects, retaining the input actor, admission and root. Execution history requires that exact original task grant, canonical root locator and matching completed release generation. Gateway history verifies the original signed calls, exact grant identity, complete EOF receipts, released generation and complete usage count. These validators authorize no execution and do not use live connection or expiry admission.

The recovery writer owner reads every fixed H1 record into its existing private disk index. Its first task-history path supports tasks already completed before H0, with the exact unprojected canonical facts retained in H0. Missing, changed or additional facts in either direction reject recovery. Unsupported retries, continuations, retained executions and unknown gateway outcomes remain blocked. The knowledge owner recognizes only its canonical empty Session selection and matching activation/status; nonempty knowledge material still requires its owning recovery closure.

`OrganizationRecovery.preflightWriters` consumes the actual callback-bound current source and original native target, requiring their exact H0 checkpoint anchor. It repeats writer classification and compares the target's actual unprojected H0 facts against fixed H1 before permanent source effects. Journal-covered policy follows the original journal definition and adoption; the preflight neither expands its coverage nor substitutes an execution proof. It returns no permit or receipt. Public `reconstruct` runs the same preflight inside its captured-source and original-target lifetime before reading retained policy receipts or retiring the source; callers cannot bypass the check by omitting the external preflight. The external operation remains available to coordinators that must check before fencing several namespaces. Final publication still consumes genuine permanent native writer inspections, rechecks the complete H1 inventory and compares actual target facts after original journal adoption in the real guarded transaction.

Hosted publication reads persisted Session information with its virtual Workspace presentation field supplied separately, then resolves the Session through its canonical facade before pausing it. Original Workspace IDs, locations and locators remain intact; the projection does not certify Workspace portability or imply an empty Workspace.

## Alternatives considered

**Accepting a final counter or DTO status** misses orphan attempts, missing release generations, extra calls and unknown physical outcomes.

**Reauthorizing old signed history with current connections** rejects legitimate history or turns fresh deployment admission into authority to change the original root.

**Fencing sources before checking unsupported deltas** makes a known incomplete mapping irreversible. Read-only preflight rejects it while both maintenance holds can still release.

**Replaying raw unprojected H1 records** bypasses the original task owners. This path requires their exact H0 facts and keeps later changes unsupported.

## Consequences

A genuinely completed model task survives service and Hosted recovery, ordinary startup and history reads without replay. The restored Session remains paused, with its original root, actor and machine identity. This path does not authorize recovery Continue, reconstruct later task deltas, restore unknown executions or enable the complete Main controller.

## Verification

Organization Runtime `test/backup/native.test.ts` runs real TLS enrollment, model EOF, original native cleanup, H0 backup, H1 policy, permanent source fences, cold target reopening, both native publications and ordinary HTTPS/WSS startup. It reads the original completed Run and input actor and verifies no additional model request. Two real completed-task variants create or change history after H0; direct `reconstruct` calls without an explicit external preflight reject both before either Source4 or retirement reservation, and both original leases release. The physical-machine fixture supplies one private coordinator through the existing canonical Local composition, shared by its active source and ordinary destination; production defaults and restricted native Home locking stay unchanged. It does not clear host-global claims or ignore unknown owners. Original canonical facts also exercise invalid signatures, missing slots/releases, unknown calls, incomplete usage and a valid signed call indexed beneath another grant through the pure history validators. Service `test/backup/writer-reconciliation.test.ts` retains roster, revocation, late-write, unknown-owner and incomplete-counter coverage.

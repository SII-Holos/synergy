# Decision Record: Resume original frozen source retirement through verified native reconciliation

Status: implemented

## Problem

A process can exit after saving its exact retirement Reference and fixed H1 archives but before reserving retirement. The original operation remains frozen and its lease belongs to the prior Runtime. Ordinary begin correctly refuses that operation, while existing cold completion requires an already committed reservation. A saved selector cannot establish current authority or recreate an opaque lease.

## Decision

Keep ordinary begin and existing completed-reservation cold startup unchanged. Add one restricted pending-retirement service mode. It selects the original Home, acquires the real process lock, attaches the original primary Store and installs the service maintenance owner without running migrations, auth, an active signer, HTTP or transports.

Current verifies the original Target's actual native installation, retained request, existing inactive material and H0 anchor. It authenticates the complete fixed H1 namespace/native archives, checks the original client settings and current native configuration, verifies covered live and archived H1 policy, and compares every actual source logical entry against the fixed archive through complete bounded scans. The existing writer owner repeats its original-target preflight. Only then does Current issue a private callback-bound admission. References, marker DTOs and caller callbacks cannot issue it.

The Kernel consumes that admission through a composition-registered owning inspector. It independently checks the actual physical Home, primary configuration, installed process lock, exact original frozen operation/request and original per-owner drainage versions and tail revision. Every required owner must implement real frozen reconciliation. The recovered RAM lease retains the original maintenanceID, request, sourceRuntimeID and FrozenInfo. It cannot drain again, release the hold or reserve another Reference. No persistent phase, pointer or ledger is added.

Reserve the original reference before native effects. Existing reservation retry stays on the original retirement completion path. After commitment, retain accepted work through file completion and Store/process-lock closure. An observer abort is treated as known completion only once the actual physical receipt exists; other validation, commit and native failures remain errors. Target policy reconstruction, fresh publication and readiness remain under their existing owners and original receipts.

`RuntimeMaintenance.withRetirementCommit()` owns that reservation transaction for the original recovered lease inside its exact frozen callback. A fixed reconciliation read verifies the native binding, original current operation/request and complete canonical reservation before admitting any completion callback. An unknown result without that row remains unknown; another reservation is rejected. The accepted callback uses a private Storage admission scope with the original native lifetime guard, independently of observer cancellation. Parent and sibling admission keep their original signals, and an escaped completion scope cannot admit later storage work. The Pending owner retains and drains the actual completion promise; only its genuine physical receipt establishes success.

## Alternatives considered

**Reusing ordinary begin** would certify an empty new process without reconciling the original native writer.

**Accepting selector or marker metadata as a lease** would bypass Current's fixed-H1 and original-Target validation.

**Changing sourceRuntimeID or creating a new operation** would discard the original immutable frozen facts and split retry identity.

**Running ordinary startup first** would load authority or attempt writes before the recovery hold was verified.

**Keep observer cancellation on accepted native work.** A cancelled artifact or queue admission can prevent the first completion read after reservation, leaving the permanently accepted operation unfinished. Cancellation still applies before commitment; the original native owner completes accepted work afterward.

## Consequences

This closes the pre-reservation process-crash window for the service source owner. It does not establish nonempty member/external writer coverage, Library recovery, execution Continue lineage or complete CLI recovery. All unsupported facts retain their original blockers.

## Verification

Organization `test/backup/pending-retirement.test.ts` uses real child processes, actual H0 Target installation and inactive material, a fixed H1 capture and fsynced Reference. It covers exits before reservation and after reservation but before the first native fence effect, immutable identities, live-Home exclusion, unsupported facts, postcommit observer cancellation with Source-close drainage, cold receipt retry and actual publication/readiness. `test/backup/pending-retirement-commit.test.ts` verifies unknown commits before and after actual SQL publication, unchanged parent cancellation, expired owned scopes and a genuine native failure followed by same-reference cold completion. Harness `test/storage/queue-admission.test.ts` retains ordinary cancellation, deadlines, priority and caller-context semantics. This dedicated owner does not generalize warm Current retirement or unfinished facet streams.

# Decision Record: Close handoff resource generations without input replay

Status: implemented

## Problem

A paused Run must stop retaining source resources before service commit. A terminal release would falsely finish that Run, while retaining the old grant would permit stale use or keep occupancy locked. After cancellation or paused target activation, the original accepted input still belongs to its original actor and machine epoch; rewriting it to the new controller would destroy admission evidence.

## Decision

Version-four grants distinguish terminal release from nonterminal handoff and control closure. Handoff closure binds the exact source generation, handoff tuple, frozen package and prepared target hash. It owns a separate finite machine signature and immutable receipt and checks the actual gateway completion set both inside the transaction and at commit. Grant state, occupancy, retained index, closure receipt and authority history commit together. Receipt replay rechecks canonical original reception and closed-grant control provenance without requiring the historical source to remain the current directory driver. Generation-zero provisional intake has its own closure cause without inventing a materialized Run.

The service inventories retained grants by an owning derived Session/epoch index. Every grant writer updates that index in its existing transaction. A central migration rebuilds it from validated canonical grants; hot inventory pages re-read the canonical grant and original accepted command and verify the count against the directory. A local lease list cannot establish completeness. Inventory and close require the current prepared handoff and authenticated source connection, and neither returns business credentials or body data.

The native source obtains the current inventory outside its final SQL transaction. Each close proof matches canonical original reception and, for a successor grant, the exact stored independent Continue. A bound generation also requires the original native root and Run. Proof creation cannot bind execution while frozen. The source retains observed closure receipts and the final empty-inventory checkpoint; its final surrender verifier only reads that checkpoint and rechecks existing native barriers. Service commit independently requires zero current retained grants. Losing a close reply does not reopen a generation; a fresh inventory reconciles progress without replaying input or repeating the closed mutation.

Paused activation creates no grant. A later independently admitted Continue supplies current control provenance and a new provisional grant, preserving the original input actor, admission, attempt, resource contract, root and native budgets. The service owns the current root-grant pointer and closes any prior held generation before replacing it. A source cancellation also requires a fresh explicit Continue, whether its resources had already closed or remained held. Current control attribution remains separate from original input attribution.

Cancellation does not restore authority to an unclosed source generation. Handoff preparation indexes its reserved epoch in the same transaction. A migration-owned derived Session/epoch index locates the canonical latest outcome using the directory's next reserved epoch; it is not a second barrier record. Shared execution eligibility rechecks the exact source tuple, cancellation fact and frozen command cutoff. It requires the canonical accepted input or independent control to cross that cutoff. Binding, description and actual gateway reservation/authorization/dispatch share this check, including capabilities reserved before the handoff. New ordinary tasks admitted after the cutoff remain usable. Retention inspection, terminal cleanup and historical receipt reads do not run this execution gate. See [the retained-cancellation incident](../../../postmortem/0111-cancelled-handoff-reenabled-retained-grants.md).

A continued terminal release must name its current grant ID explicitly. The service compares that selector with its resolved canonical grant, including before idempotent receipt lookup. Legacy proofs without continuation retain their original contract; any supplied selector must still match. Clients verify the same current binding, original input and control provenance. Native organization portability reader two declares this continuation contract; a reader that only understands the earlier organization closure is rejected before package content is read.

## Alternatives considered

**Call terminal release during handoff.** That invents completion or cancellation for a Run whose task, continuation and budgets must survive.

**Rewrite original input to the destination or controller.** It changes the immutable actor and admission and makes a repeated initial prompt appear legitimate.

**Close only remembered local leases.** A crash can leave an accepted provisional or held service grant before its local callback records a lease.

**Reuse the original grant after activation.** Its source binding and generation no longer authorize destination execution or independent control.

## Consequences

Legacy grant upgrades preserve original bytes on read and do not fabricate handoff history. Previous strict grant readers reject the new version. The retained index is derived and migration-owned; grants and directory counts remain authoritative. Nonterminal closure does not reset native budgets, create a root, unpause work, allocate target resources or dispatch a model.

This unit implements explicit continuation and handoff resource closure. The existing automatic terminal observer still needs per-current-grant reconciliation for renewed post-handoff generations; its original request row is not a replacement grant authority. Main keeps complete handoff capability disabled while that integration and Workspace, Environment and knowledge closure remain unfinished.

## Verification

Service tests cover actual live gateway streams, exact source/target proofs, changed tuple/generation/hash, immutable replay, closure-write rollback, legacy migration and retained-index completeness beyond a page. Native tests preserve the original task receipt, root, actor and Run through source cancellation and target activation. Enrolled member/hosted Homes use generated APIs over verified HTTPS and actual WebSockets to close source occupancy, preserve an unknown committed-close result, activate paused, admit a separate Continue, bind a fresh generation, finish the same native Run and release the exact new grant. No user Runtime or real Home is used.

# Decision Record: Write recovery history under original native permits

Status: implemented

## Problem

A correctly imported target must remain recovery-held while its owning domains reconstruct current authorization and deployment state. Ordinary writes are blocked by that hold. Releasing it before reconciliation would expose execution, while a caller-provided transaction cannot establish the native installation that owns a reconstruction.

## Decision

`RuntimeMaintenance.restorationTransaction` opens one protected write transaction for the original `HomeRestoration` permit and exact request. Before SQL it freshly verifies permanent native Home ownership. Inside SQL it verifies the retained installation reference, distinct recovery-held target and unchanged frozen source history. The private mutation context admits ordinary domain records only within that original Runtime, Store, transaction and callback.

Maintenance records remain reserved to their existing owner. The reconstruction callback cannot replace the current pointer, release its hold or rewrite archived maintenance facts. `assertAdmission` continues to reject execution. An original native permit alone is insufficient before the actual namespace import and maintenance adoption.

The callback closes independently of the transaction's final decision. The actual SQL commit guard retains the original native Home/request/ownership and cancellation after any supplied guard. A Home callback ending during a held last write rolls back the new records. Caller guards and original queue options remain effective. Generic operation IDs are rejected; immutable publication receipts belong to the domain performing reconstruction in that same transaction.

The existing adoption path and reconstruction share the retained-reference validator. No new persistent phase, ledger, migration or release mechanism is introduced.

## Alternatives considered

**Release maintenance before reconstructing policy.** That grants ordinary admission while restored authorization and writer evidence remain incomplete.

**Bypass mutation protection for every native Home callback.** Native installation also performs verification and staging before the target has an adopted recovery hold. A reconstruction needs its own short write callback and exact retained reference.

**Expose a reusable transaction or boolean bypass.** Escaped, foreign or caller-fabricated contexts would lack the original native lifetime and final commit checks.

## Consequences

Owning recovery domains can reconstruct records while login readiness and execution remain blocked. They still need complete current authorization, history continuity, native writer evidence and their own publication receipts; this primitive does not supply or approve those facts.

`test/storage/runtime-maintenance-adoption.test.ts` uses actual authenticated namespace import and native adoption. It rejects unadopted, copied, nested and expired permits, preserves the hold and source facts, rejects reserved maintenance writes, rolls back policy plus receipt on final-guard failure and cancellation, and ends the real Home callback while a staged write waits before commit. Existing maintenance, cold restoration and import-adoption suites retain their own regressions.

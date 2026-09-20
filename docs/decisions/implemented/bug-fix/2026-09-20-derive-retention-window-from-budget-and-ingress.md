# Decision Record: Derive the retention window from the byte budget and measured ingress

Status: implemented

## Problem

Two limits that had to hold together were configured independently, and nothing asserted their relationship. `storage.retentionMs` promised 7 days of authoritative evidence and `storage.retentionBytes` budgeted 40 GiB for holding it. Measured ingress is roughly 9 GB per day, so a 7-day window needs about 63 GB — 1.6 times the budget. The window and the budget were each internally reasonable and jointly unsatisfiable.

[The busy-worker incident](../../../postmortem/0020-busy-sqlite-worker-declared-dead.md) is what that produced. Every 15-minute sweep found the store over budget, enumerated owners, discovered that everything the window permitted removing was protected, and reported `infeasible`. That report was honest, and it did not stop the loop: the sweep stayed scheduled permanently and repeated the same enumeration against a store that was always over budget. The condition `overBudget && pruned === 0` was the steady state rather than an exception.

The byte budget was therefore unreachable by construction. Nothing in the system could report how much evidence the budget actually held, so an operator saw an `infeasible` warning with no number attached to the promise that was making it unachievable.

## Decision

**The operative window is derived from the byte budget and the observed ingress rate.** `effectiveWindow = clamp(maxBytes / ingress, floor, retentionMs)`, where the floor is one day. `storage.retentionMs` becomes a promise ceiling: the window never exceeds it, and is shortened below it when the budget cannot hold what it promises.

**Ingress is estimated from signals a pass already has.** No new SQL query or table scan is added. A pass measures `physicalFootprint` — a `statSync` of the database and its sidecars, which `SqliteMaintenance` already performs — and adds back the pages the previous pass released: `ingress = Δfootprint + (previous releasedPages × pageSize)`, divided by the elapsed interval. The released pages are added back because a footprint recorded after a reclaim no longer contains them; without that, a pass that returned bytes would read as a fall in ingress and lengthen the window it had just paid to shorten. A page is 4096 bytes, SQLite's documented default, because the worker never sets `page_size`; reading the real value would put a statement on the sweep whose purpose is to decide its work from signals it already has.

**The estimate is smoothed and persisted.** Each measurement is halved against the estimate it updates, because one interval can carry a migration, a bulk import or a vacuum, none of which is steady-state ingress. The sample lives at the `storage_meta/retention-ingress` key — the family the store already keeps its own bookkeeping in, alongside `identity`, the artifact migration state and notification reconciliation — so a restart resumes from the measured rate instead of re-learning it.

**Degenerate cases fall back instead of guessing.** With no prior sample, with a non-positive rate, or with no byte budget at all, the configured window stands. A store whose footprint shrank reports no ingress rather than a negative rate.

**A shortened window is a named degradation, not `infeasible`.** `Report` carries `effectiveWindowMs`, `windowReduced`, `ingressBytesPerMs`, and `infeasible` now means the narrower condition it always described: the budget cannot hold even the one-day floor, so no evidence this policy permits removing can reach it. A reduction raises `STORAGE_RETENTION_WINDOW_REDUCED`; a budget below the floor raises `STORAGE_RETENTION_BUDGET_INFEASIBLE` and prunes nothing, because deleting the oldest evidence the policy permits would still leave the store over budget. A rate of report no longer repeats as a no-op, because the reduction is what the next sample resolves: the estimate rises, the window shortens, and the evidence protecting the budget falls outside it.

**The floor never exceeds the configured window.** An operator who retains for six hours has already asked for less than a day; extending their window to the floor would retain evidence they chose to drop. The floor is therefore `min(WINDOW_FLOOR_MS, retentionMs)`.

**Nothing about the protections changed.** Pruning still runs only while the footprint exceeds `maxBytes`; an owner whose newest record is inside the window is never touched; a live session is never touched; whole trees are removed oldest-first.

## Alternatives considered

**Keep the fixed window and raise the default budget to ~63 GB.** This makes the default configuration self-consistent and moves the defect to every installation that does not change the default: the mismatch reappears the moment ingress exceeds the measured figure, and it reappears silently, because the new number has no more relationship to the rate than the old one did. Deriving the window is what removes the class of defect rather than this instance of it.

**Keep the fixed window and lower the default to roughly 4 days.** It fits today's 40 GiB budget at today's ingress and stops fitting when ingress rises 20%. It also encodes a measured ingress rate as a constant, which is the same mistake as before with a tighter margin.

**Store the ingress estimate in a process-local variable.** It is the cheapest option and it loses the estimate on every restart, so each restart re-learns the rate from two passes an interval apart — 15 minutes of applying a window the store may never have been able to hold. Persisting it is one `readMany` and one `write` per pass, against a store the pass is already reading and deleting from.

**Persist the estimate as a new dedicated table or a versioned migration.** The store already keeps owner-scoped bookkeeping under `storage_meta`, and the sample is one small record that any version can ignore: treating it as absent is a correct fallback, so it needs no migration. A table would add schema and a migration to a path that must keep working when the sample is missing.

**Read the real page size from the worker.** Correct in principle, and it puts a statement on the sweep that exists to avoid paying for one. SQLite's default page size has been 4096 since 3.x and the worker never issues `PRAGMA page_size`, so the constant is exact for this store. The released-page count is a correction term on an estimate, not an accounting figure.

**Use the released page count without adding it back.** This is the tempting simplification, and it under-reports ingress in exactly the case that matters: a pass that pruned and reclaimed aggressively would read as a store that shrank, which lengthens the window the pass just paid to shorten. Adding back the previous pass's release is what keeps the two measurements comparable.

**Treat every reduced window as `infeasible`.** A reduction is the designed outcome of a budget that holds days rather than a week, and reporting it as unreachable would leave the same permanent warning the fix exists to remove. Separating the two conditions is what makes an `infeasible` report actionable.

**Enforce the floor by refusing to prune at all.** A store on a budget that holds three days would then retain nothing until an operator intervened, which is worse than retaining three days. Pruning down to the floor is the useful behavior, and the unreachable case is reserved for the budget that cannot hold even that.

**Raise `STORAGE_RETENTION_WINDOW_REDUCED` on every pass.** The sweep runs every 15 minutes, so a steady state would emit ~96 warnings a day. `ObservabilityIssues.raise` already coalesces by fingerprint — one open issue that accumulates `occurrenceCount` — which is the convention the neighbouring conditions use.

## Consequences

A store can no longer claim to retain more than its budget holds. The window contracts toward `maxBytes / ingress` as ingress rises and relaxes back toward `retentionMs` as it falls, so the two limits move together instead of contradicting each other; the `infeasible` state now describes a budget that is genuinely unreachable rather than the ordinary consequence of a fixed window beside a smaller budget.

An operator who configured a 7-day retention window will observe shorter retention on a store whose budget cannot hold a week, and `STORAGE_RETENTION_WINDOW_REDUCED` names the computed window and the rate that produced it. The remedy is to raise `storage.retentionBytes` or to lower `storage.retentionMs` so the promise and the budget agree; the configuration descriptions state this. Retention remains irreversible for pruned owners, and the window gate, live-session protection and oldest-first whole-tree removal are unchanged.

The estimator adds one durable record per over-budget pass and no new measurement: the footprint is a `statSync` the pass already paid for, and the released page count is already in `Report`. A pass with no sample still behaves exactly as before, so an installation upgrading into this change applies the configured window until a second over-budget pass establishes a rate. Because the estimate is smoothed, a genuine step change in ingress takes more than one interval to reach the window it implies, which is the intended trade against a single import or migration setting the window for a week.

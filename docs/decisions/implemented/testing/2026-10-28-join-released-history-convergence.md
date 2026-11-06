# Decision Record: Join historical convergence before asserting migration replay

Status: implemented

## Problem

A historical Session becomes readable when its imported locator commits, before the import job finishes global after-convergence migrations. The complete released-project fixture prepares both retained Sessions but immediately invokes a second migration runner. That runner can legitimately finish the two usage scheduling migrations and report two completions, instead of testing whether completed work replays. Readable history and completed global migration receipts are different observations.

## Decision

The [released-project fixture](../../../../packages/presets/test/storage/released-project-upgrade.test.ts) waits for the existing `completeDeferredMigrations()` promise after both Sessions pass their ready, transcript and unknown-data assertions. It then retains the strict `completed: 0, failed: 0` replay assertion. All frozen release ledgers, directory states, restart checks, new-work admission and original deadlines remain unchanged. This fixture has explicitly prepared its entire two-Session historical cohort; the wait is not a new Session-readiness requirement.

A [deterministic subprocess control](../../../../packages/presets/test/storage/released-project-convergence.test.ts) reuses the original released 3.0.22 looping-symlink case. Its test-only preload holds the product's first usage convergence before the receipt read, observes the fixture joining that already-running task, and rejects entry into the replay runner before convergence finishes. It records actual usage migration body entries from both runner and convergence paths. Each runs once in the first Runtime and neither runs again after restart. The first opening forces the interleaving; the second verifies persisted receipts rather than claiming another physical hold. Missing instrumentation anchors fail setup instead of silently removing coverage.

The child has a 55-second lifecycle deadline within the parent's 60-second test. On expiry the wrapper terminates only its owned child, cancels pending output readers and joins exit and stream settlement before disposing the isolated Home. A framework timeout alone does not unwind an in-flight promise. The original replay case still has 30 seconds; the remaining parent time is teardown headroom, not an extension of business execution.

## Alternatives considered

**Accept nonzero replay completions.** This would weaken the idempotency assertion and could hide actual repeated work.

**Delay Session ready until global convergence.** Readability does not require unrelated historical usage work. Coupling them changes the product's demand-driven preparation semantics.

**Sleep, poll receipts or retry the test.** These approaches depend on scheduler speed or can overlap the active migration job again. The existing promise provides the relevant completion event.

**Serialize online migration entrypoints in the product.** Current production callers use startup or exclusive maintenance. The fixture's additional online runner does not establish a production requirement for another coordination mechanism.

## Consequences

The original matrix remains twenty cases and 656 assertions. The extra control adds one real-case subprocess; local green samples measured 8.58 seconds for the matrix and 1.70 seconds for the control, not a CI performance estimate. Its checks require product-started convergence, awaited completion and one body execution across restart, so waiting must not silently repair a missing trigger or lost receipts.

A controlled same-fixture interleaving reproduces the CI summary of two completed and two deferred migrations; joining produces zero completed with the two explicit-maintenance migrations still deferred. The original CI failure did not record migration IDs, so this evidence does not identify its exact interleaving. This change does not alter migration algorithms or resolve unrelated historical tool-side-effect, conversation-visibility or native-geometry investigations.

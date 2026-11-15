# Cold derived pages repeated tree cleanup

## Executive summary

Cold attachment and native-field preparation shared a transaction per migration page but removed each Part's derived tree separately. Repeated reference-GC, tombstone and node statements added per-producer dispatch work even for empty derived trees. An explicit Store-owned tree batch combines those known selectors while preserving independent artifact cleanup, current canonical recapture and page rollback.

## Summary

The original Channels history case exceeded its CI framework guard during preparation. A separate local two-stage diagnostic placed almost all preparation work in Session migrations, with attachment metadata and native field sources dominating that observed run. Display preparation itself was small. This distinguishes the local preparation phases; it does not identify every cause of the earlier CI elapsed time or establish a fixed performance gain.

The diagnostic's anonymous `insert:artifacts` classification matched the first whitelisted table appearing in SQL, including `FROM storage_artifacts` in an INSERT whose actual target was `storage_artifact_gc`. Its count is retained as observed. It does not show new binary publication: ordinary text/reasoning source chunks are records, and nonattachment producers publish empty attachment headers. The repeated work was tree cleanup for two independently owned projections.

## Timeline

- The original large-history case timed out while its preparation continuation was still running. The fixture's history, Parts and original migration entry remained intact.
- Local passive stage observation enumerated the original producers through both migrations and separated migration work from display preparation. Same-Runtime SQL-request totals included background activity and did not measure exclusive owner CPU time.
- The real existing-API regression seeded 33 canonical historical Parts across the original page boundary. Both owners preserved canonical bytes, revisions, derived headers and original native results before failing the native GC-intent bound: 33 actual statements where at most two were required. The qualified baseline had two failures and ten assertions, with source and HEAD unchanged by execution.
- After the Store and owner change, the six owner cases passed 40 assertions. Positive dispatch work and the page upper bound passed alongside malformed-suffix retry and a canonical revision changed after the original preparation snapshot. This is a local work-bound result, not large-history or CI acceptance.
- The first Store execution passed its two guard cases but failed its SQLite plan cases at COMMIT because the diagnostic EXPLAIN statement remained active in the worker cache. That fixture failure is not a production RED. The plan check was moved to an independent readonly connection over the same database, using the exact captured statement and parameters and explicit statement finalization; the corrected two-file run passed ten cases and 134 assertions, retaining the exact statement and indexed-range/no-table-scan assertions.
- The initial owning TypeScript run reported only the new range test's optional-byte result. The test adds an explicit missing-byte failure before comparison; the complete owning TypeScript rerun passed, with tracked sources and HEAD unchanged and the unrelated build-info bytes preserved. This test correction is not a production semantic defect.
- The new tree-removal contract file was added to the existing PostgreSQL contract inventory, so the supported PostgreSQL CI jobs select its two scenarios. Registration is not a PostgreSQL execution result.
- The first PostgreSQL plan control incorrectly used ordinary revision reads to inspect deleted rows and selected nonmatching files with an exact-name filter. These fixture and selection failures were corrected using the existing raw tombstone reader and one whole selected file. The resulting real plan and semantic control passed one case and 151 assertions; filtered JUnit entries were recorded separately, and the owned container was removed.

## Root cause

The domain page already knew its pending derived prefixes, but invoked the complete single-tree deletion protocol for each one. Tree existence and artifact-reference existence have different indexes, so a cheap node-only absence shortcut would weaken cleanup. Reusing one explicit Store array operation combines the physical work without guessing absence or bypassing the canonical owner.

The page then serially rereads each canonical producer under its original writer. Separate migration receipts, encoded normalization, current revisions, immutable source versions and later write guards remain authoritative. No ordinary append path is changed.

## Guardrails

- [x] Machine check: `packages/harness/test/session/native-derived-page-work.test.ts` — original-API native dispatch RED, preserved bytes/headers/native result before the budget assertion, positive bounded work after correction, committed earlier pages, malformed suffix retry and current-revision recapture.
- [x] Machine check: `packages/harness/test/storage/tree-removal-batch.test.ts` — complete SQLite Store execution after diagnostic-statement finalization, including actual plan, formats, overlapping revisions, exact ranges, independent artifact refs, retained shared packs, foreign namespace, guard/publication refusal and rollback.
- [x] Machine check: the twelve complete owner and original neighbor files passed 69 cases and 1,496 assertions, including attachment-index, part-field-header, artifact-subtree, node-cleanup, compatibility admission and existing Store contracts; the owning TypeScript check passed.
- [x] Machine check: the four complete owning files passed against real PostgreSQL 17.11: 46 cases and 625 assertions, with two explicit SQLite-only skips. The required publication and two new tree-removal cases passed, and the exact selected file inventory and task-owned container removal were verified. The same Store inputs remain unchanged.
- [x] Machine check: the actual PostgreSQL 17.11 artifact-plan control passed 151 assertions with the ordinary planner and sequential scans enabled. Two original mutations each visited 128 selected-owner candidates among 8,192 unrelated same-namespace references; the namespace-only negative scan visited 8,448 total candidates and was rejected. Exact original statements and parameters were probed under rolled-back savepoints before their ordinary operations, then tombstones, orphan references, retained neighbors, foreign namespace and GC were verified. This permits owner-index filtering, not per-Part exact seeks or a latency claim.
- [x] Machine check: the complete original Channels delivery-work file passed five cases and 26 assertions, including both 500- and 5000-message histories with over 2000 Parts, under its unchanged workload and deadlines.
- [ ] Machine check: complete original CI acceptance remains required on the published candidate.
- The [implemented decision](../decisions/implemented/bug-fix/2026-11-15-batch-cold-native-derived-tree-removal.md) defines the new array-operation semantics and unchanged ordinary capture.

These checked local results do not accept the remaining configured CI gates. This correction does not change the ordinary capacity producer or establish a whole-capacity improvement.

## Lessons

Identify the actual target and purpose of observed SQL before inferring artifact publication. Batch known selectors in their storage owner while keeping independent reference cleanup and fresh producer evidence. Qualify work-count regressions before timing claims, and finalize diagnostic statements so the observer cannot create the transaction failure it is investigating.

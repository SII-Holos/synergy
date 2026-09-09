# Decision Record: Shard CI test and coverage execution behind aggregate and fan-in gates

Status: implemented

## Problem

Both heavy CI jobs were single-runner serial executions. Coverage ran 18.4–21.2 minutes across four successful runs (2026-09-08/09, runs #4279–#4284), with `bun script/gates.ts ci-coverage` occupying 17.8 of those minutes executing all 27 coverage-manifest commands serially on one runner. Test ran 14.3–15.1 minutes on one runner: `bun turbo test --concurrency=2 --filter='!@ericsanchezok/synergy-harness'` at 10.9 minutes followed by four serial steps (browser smoke 1.0m, plugin UI contracts 1.1m, release contracts 0.1m, Harness shards 1.4m). The workflow also had no `concurrency` group, so stacked pushes on one branch ran overlapping full pipelines. Baseline measurement attributed ~11.9 minutes of coverage wall-clock to four packages: `product-runtime` 2.76m, `apps/web` 1.95m, `ui` 1.67m, `harness` 1.43m.

Grouping could not reuse the existing `--package` filter with per-group threshold evaluation: the gate's union semantics credit each source owner with hits from every package's tests (`product-runtime`'s integration suites feed 21 owners; `harness`, `cli`, `connections`, and `agent-integrations` sit within 1–2 points of their 75% floors only with that credit; `testing` and `workbench` flip to FAIL without a single cross-package file). A per-shard evaluation would false-fail those owners on every run.

The `dev-protection` ruleset pins eight exact check names, including `Test` (Coverage is not anchored). Matrix-sharding an anchored job under a new name breaks branch protection silently.

## Decision

Execution splits at process-isolated boundaries; evaluation and required-check identity stay whole:

1. **Coverage two-phase**: `coverage-shards` (four duration-balanced matrix shards, `fail-fast: false`) run manifest commands with `coverage-check.ts --execute-only` and upload every lcov plus a root anchor file (the anchor keeps upload-artifact v4 from trimming repository-root-relative paths to their common ancestor). The `Coverage` job downloads with `merge-multiple: true` and runs `--aggregate`, which unions cross-package hits exactly when every manifest package has a report. Verdicts are byte-identical to the previous full run: 27/27 packages, zero deviation on a local baseline (lines/functions/measured/missing/exempted).
2. **Test split**: `test-shards` (four matrix shards) run the 24 non-harness workspace test packages through `bun turbo test --concurrency=2` with per-shard `--filter` lists wired through `TEST_PACKAGES`; `test-aux` owns the private HTTP browser smoke, plugin UI contracts, and release contracts, building the app and its dependency dist first (the old job relied on turbo's `^build` side effects for the plugin dist those contracts consume); `test-harness` keeps the isolated fresh-process Harness shards and per-shard JUnit reports. The anchored `Test` name survives on a fan-in job that fails unless all three succeeded — the same anchoring pattern the coverage split applies to `Coverage`.
3. **`script/coverage-check.ts`** gains `--execute-only` (run shard commands, never evaluate thresholds), `--aggregate` (evaluate unioned thresholds from existing reports, fail on any missing report), and comma-separated `--package` values. The union condition parameterizes the previous "unfiltered invocation only" rule instead of weakening it: filtered non-aggregate invocations keep package-local semantics.
4. **`concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }`** cancels superseded PR runs while never cancelling dev/main pushes.
5. **Contract coverage in ci-static**: `ci-matrix:check` runs `test/script/coverage-matrix.test.ts` and `test/script/test-matrix.test.ts`, pinning the partition invariants (shard lists cover exactly the manifest packages, and exactly the non-harness workspace test packages), fail-fast disabled, artifact shape, aggregate and fan-in wiring, bounded shard concurrency, and the eight ruleset-anchored check names remaining present.

## Alternatives considered

- **Per-shard threshold evaluation with credit-aware grouping.** Rejected: the cross-package credit graph is dense enough that no static grouping reproduces shared verdicts; owners at 75.0–77.7% would flip on noise. Aggregate evaluation reproduces the shared numbers exactly by construction.
- **One shard per package (27 coverage / 24 test shards).** Rejected: best wall-clock but roughly 24–27 concurrent runners per push and per-shard setup overhead multiplied across shards; duration-balanced groups keep the longest shard near 3.5 minutes of measured work.
- **Merging Test and Coverage into one run that records lcov and reports together.** Rejected for Bun 1.3.14: coverage must be enabled at process start, so a Test-job process cannot retroactively produce lcov; the duplicate execution is the price of isolation-correct sharding until the Bun ≥1.4 `--parallel` upgrade path (tracked in the 2026-09-04 sharding record).
- **Splitting Test under new check names and editing the dev-protection ruleset to re-anchor.** Rejected: a ruleset edit requires org-level coordination and opens a protection gap while it lands; the same-named fan-in keeps the required-check contract stable with zero ruleset changes.

## Consequences

The critical path drops from ~19–21 minutes (Coverage) to roughly the slowest shard (~3.5 minutes of measured work plus ~2 minutes setup) plus a sub-minute aggregate; the Test chain drops from ~15 minutes to its slowest member (~5–6 minutes for the runtime shard including setup). Runner peak per push rises from 11 jobs to about 18. Coverage math, thresholds, exemptions, and the isolation-list semantics from the 2026-09-04 sharding record are unchanged — the split happens only at package boundaries, which are already process-isolated. Superseded PR runs stop burning runners. Both gates now trust artifact plumbing and fan-in wiring: a lost report surfaces as a hard failure through `if-no-files-found: error` on coverage uploads or a missing lcov in the aggregate, and the test fan-in fails on any skipped or failed leaf, so neither failure class can silently pass.

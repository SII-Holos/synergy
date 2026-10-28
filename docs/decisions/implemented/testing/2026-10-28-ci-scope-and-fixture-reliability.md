# Decision Record: CI scope and fixture reliability

Status: implemented

## Problem

A local test or metadata edit can trigger unrelated runtime matrices when test dependencies are treated as production edges or root test ownership is absent. Browser compilation and competing heavy tasks extend the critical path. Process-wide mocks and unowned queued work allow one test to contaminate later tests, while rerunning a file alone hides the failure.

## Decision

Keep full dev/main pushes and scheduled cold runs. PR selection separates production impact from conservative test-consumer coverage, classifies known existing workspace manifest fields, and registers root browser acceptance explicitly. Unknown fields and unresolved integration inputs remain conservative, with unresolved paths in plan reasons. Coverage thresholds and scenario inventories are unchanged.

Distribute Web batches across the existing six ordinary Linux execution units. Plan and execution share admission rules: at most one heavyweight browser/build/native task runs per runner, while light tasks fill either of its two available slots without waiting for a whole wave to complete. Persist preparation and cleanup durations and failures before command startup. Read every page of GitHub execution history with bounded page size while retaining current-run provenance.

Use static compiled browser fixtures with independent pages, scoped filesystem spies and owned worker-queue leases. Queue assertions observe state at the acknowledged receipt; subsequent diagnostic queries can flush unrelated observations. The shared resource helper drains in reverse acquisition order and aggregates named cleanup failures. The stability command repeats explicitly selected files or their original batch in fresh Homes with recorded order seeds, preserves all attempts and fails if any attempt fails. The test policy rejects focused tests and increases in retries or unisolated module replacements relative to the exact base; fixed sleeps and existing debt in edited tests remain review advisories.

The file-explorer and source-navigation fixtures retain one prepared Vite server and Chromium process per file but give every case its own browser context and page. Viewport, theme, scroll position, clipboard stubs and page errors belong to that case. Their immutable files require neither watching nor HMR. Source navigation prepares the first editor load within its existing setup deadline using a disposable warm-up page; fault injection and editor state remain fresh in each test. The existing restoration, menu, mutation, source-loading and keyboard assertions retain their deadlines; isolating their state adds no duplicate scenarios.

## Alternatives considered

**Increase global timeouts or rerun failed tests automatically.** This hides ordering and ownership defects while raising feedback cost; it does not demonstrate a repaired invariant.

**Skip unknown inputs or move correctness acceptance off PRs.** This risks missing migration, platform or installation regressions. Unresolved dependency boundaries remain explicit optimization work, never permission to omit tests.

**Buy faster runners or increase concurrent jobs.** Existing execution capacity can first be used more effectively through balanced partitions and immutable fixture reuse. Runner upgrades require separate evidence and authorization.

**Replace the complete test framework.** Existing Bun executors already preserve isolation and coverage inventories. Focused improvements retain their contracts and avoid a second execution path.

## Consequences

Selection becomes narrower where ownership is proved, while full CI and unknown-input costs remain visible. Heavy tasks sacrifice overlap with other heavy tasks to reduce resource contention; light work continues whenever capacity is available. Fresh-context browser fixture reuse improves preparation without relaxing assertions. Local Settings acceptance retained 21 tests and 244 assertions: 29.0 seconds with the development server, 14.1 seconds with cold static compilation and 11.8 seconds warm on the same machine. This experiment does not establish hosted CI latency or a statistical flake rate; PR P50/P90 and full-run timing require continued comparable measurements. The policy deliberately ratchets existing debt rather than forcing unrelated fixture rewrites.

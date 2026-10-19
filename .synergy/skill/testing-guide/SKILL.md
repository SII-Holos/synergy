---
name: testing-guide
description: Design, write, run, and diagnose Synergy tests with Bun, temporary Scope isolation, deterministic fixtures, and behavior-first assertions. Use for TDD, bug regressions, feature tests, migration tests, flaky tests, coverage, package tests, frontend tests, and selecting verification gates.
---

# Test Synergy Behavior

## Development Feedback Loop

Start with `bun run verify plan` to inspect the working-tree impact, including uncommitted new files. Iterate with the narrow behavior test. Before publication, run `bun run verify local --test <repository-relative-test>` with every relevant test selected explicitly. The owning executor validates the selection, passes static gates, then runs selected tests with fresh coverage and checks new measurable source. Complete package coverage and platform matrices remain pending CI evidence.

Use `bun run verify coverage --package <workspace>` when changing coverage policy, removing substantial test coverage or changing instrumentation. A focused LCOV report cannot establish package thresholds. Finish generation and self-review before this checkpoint. Collect all causal failures from one CI attempt before making the next focused correction; infrastructure retries retain the same SHA.

## Avoid concurrent artifact mutation

Finish or cancel concurrent file writers before final verification. Never run static gates alongside browser suites or builds in one worktree. Reuse passing evidence unless changed inputs invalidate it; preserve isolated Homes, fresh reports and real Scope fixtures. Raw Harness coverage/parallel commands are unsafe; use the canonical executor.

Read [the domain guidance](references/isolation.md#avoid-concurrent-artifact-mutation) when this area is affected.

## Workbench Presentation Acceptance

Read [the domain guidance](references/browser-acceptance.md#workbench-presentation-acceptance) when this area is affected.

## Local Joint Acceptance

Read [the domain guidance](references/browser-acceptance.md#local-joint-acceptance) when this area is affected.

## Review Test Value and CI Cost

1. Before adding a scenario, inspect nearby coverage and name the observable behavior, the real failure it prevents, and what existing tests leave uncovered. Extend a suitable existing test when it already owns that behavior. File size, assertion count and coverage percentage alone do not establish value.
2. Review the affected old tests in the same change. Delete obsolete behavior, consolidate duplicate coverage, and replace assertions about source strings, callback names, incidental structure or fixed style values with observable results where needed. Record what was retained, combined or removed and why; there is no quota for adding or deleting tests.
3. Put shared behavior at its lowest useful level. Keep adapter-specific integration at each adapter; add model, protocol, platform or outcome combinations only when they protect a distinct failure. Reuse immutable preparation while retaining separate mutable Homes, processes and DOMs.
4. When replacing expensive acceptance, demonstrate that the retained test rejects a relevant fault such as a missing file edit, lost recording or failed continuation. Preserve public lifecycle, installation, migration, cancellation and recovery checks and coverage floors. Repetition and long sessions need an identified size, duration or accumulation failure; duplicate historical stress belongs in an explicit diagnostic.
5. Measure preparation, execution, cleanup, upload and queues for changes to expensive fixtures, matrices or CI. Compare equivalent cold and warm runs, report the incremental cost and its useful coverage, and update task weights from observed time. Diagnose flakes at their observed stage; blanket retries, longer sleeps and hidden skips cannot justify growth. Use [CI cost policy](../../../docs/operations/ci.md#维护验证成本) when reviewing a longer critical path.

Use stable primary responsibilities for built-in behavior tests. Keep concrete primary names in the single identity contract and historical upgrade fixtures. Renames do not need per-name acceptance or rejection tests when ordinary agent lookup handles them. Unrelated message, protocol and UI fixtures use shared synthetic agent names; tests resolving an agent explicitly register that fixture. Consolidate duplicate coverage without removing distinct permission, lifecycle, migration or rendered-prompt budget checks.

## Define the Invariant First

Read [the domain guidance](references/test-design.md#define-the-invariant-first) when this area is affected.

Optional components require behavioral absence, reinstall and interleaved-Runtime tests. Select minimal requirements, import unselected factories, and inspect actual tools, agents, prepared prompts, public schemas, events, service activity and HTTP requests. Write data with the owner installed, remove it and update unrelated configuration, then reinstall and verify retained data and drafts. Exercise delayed installation, interrupted owner migrations, repeated execution and failed startup. Web composition changes include mobile paths and a real same-URL backend restart; packed dependency closures, native workers and managed Node SDK acceptance cover resolution outside the workspace. Source-string assertions cannot prove capability absence. Browser fixtures declare their confirmed features through the host capability context; generic fixtures must not silently grant every optional owner. When moving suites to leaf packages, move their process-isolation rules to the new paths as well.

When migration ownership moves, update historical fixtures to execute the migrations registered by the current composition. Retire unused aggregate migration implementations instead of keeping a parallel upgrade path solely to satisfy old tests. Preserve historical receipt compatibility and assert retained data and repeated execution through the real owners.

## Choose the Lowest Useful Level

Read [the domain guidance](references/test-design.md#choose-the-lowest-useful-level) when this area is affected.

## Use Real Isolation

Read [the domain guidance](references/isolation.md#use-real-isolation) when this area is affected.

## Local Performance Experiments

Read [the domain guidance](references/local-verification.md#local-performance-experiments) when this area is affected.

## Run Harness Suites Through the Orchestrators

Read [the domain guidance](references/local-verification.md#run-harness-suites-through-the-orchestrators) when this area is affected.

## Run Narrow to Broad

Read [the domain guidance](references/local-verification.md#run-narrow-to-broad) when this area is affected.

## Diagnose Failures

Read [the domain guidance](references/local-verification.md#diagnose-failures) when this area is affected.

## Handoff

For a specific regression, search [domain regression patterns](references/regression-patterns.md#handoff) for the affected subsystem; read the matching paragraphs only. This includes CI evidence, native coverage, browser providers, streams and cancellation.

Report the invariant, test location, red/green evidence, commands run, pass/fail counts, unrun gates, platform limitations, and any remaining nondeterminism.

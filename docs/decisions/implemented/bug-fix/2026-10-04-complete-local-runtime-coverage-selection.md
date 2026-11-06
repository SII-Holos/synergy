# Decision Record: Preserve Local Runtime coverage contributors in affected CI

Status: implemented

## Problem

A Web change selects the Windows native verification through Desktop. That task selects the two Local Runtime baseline partitions, but those partitions do not exercise every Local Runtime source file. CLI Scope helpers, component registration, worker registration, Skill summaries and Workspace relocation are exercised by downstream CLI and Presets tests. Full CI merges those reports; the affected plan omitted them and rejected coverage with five missing source records after every selected test succeeded.

## Decision

Both Local Runtime suite partitions depend on the complete CLI and Presets suites in the task catalog. The existing transitive task selection includes their reports when a native task selects Local Runtime indirectly. A behavioral planning regression starts with a Web source change and verifies all contributor partitions execute exactly once while unrelated package suites remain unselected.

The report checks and coverage thresholds from the [CI verification decision](../testing/2026-09-24-ci-verification-plans.md) remain in force. Admission requires fresh complete reports from the selected tasks in the current plan, tested revision and workflow run.

## Alternatives considered

**Lower thresholds or exclude the five files.** The files have existing executable behavioral tests and full CI produces their source records. Excluding them would conceal missing test selection.

**Require every PR to run full CI.** This avoids the missing reports but discards affected selection for unrelated suites. Explicit coverage dependencies preserve the existing narrower plan.

**Duplicate the downstream tests in Local Runtime.** The CLI and Presets tests exercise their actual composition and consumer behavior. Duplicating them would add maintenance and execution cost without additional behavior coverage.

## Consequences

Affected plans that include Local Runtime also run one CLI suite and four Presets partitions. Full plans still execute each suite once. This increases work for indirectly selected Local Runtime checks while retaining the same coverage policy and avoiding historical or unselected evidence. Coverage contributor dependencies must be maintained when behavioral tests move between packages.

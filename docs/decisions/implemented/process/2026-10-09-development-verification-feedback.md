# Decision Record: Development verification feedback

Status: implemented

## Problem

Static preflight does not execute product tests or establish coverage. Repeating static commands in a push hook adds latency without discovering changes when their inputs are identical. Uncommitted new source can also be absent from revision-only verification plans.

## Decision

The root `verify` command previews CI selection from the complete working tree and runs explicitly selected behavior tests through the owning coverage executor. Fresh focused reports detect newly added or newly measurable source missing from LCOV. Complete package thresholds and platform acceptance remain CI responsibilities; explicit package coverage is available locally.

Local static checks and the pre-push hook share content-addressed success receipts for deterministic checks. Receipts bind all tracked and non-ignored working inputs, file modes, link targets, commands and the toolchain. They expire after one day, are written atomically, and cannot be used in CI. Changed inputs during checks reject the result. Staged pre-commit checks retain their independent index semantics.

CI collects independent coverage diagnostics even when another task fails, while admission still requires every selected task and complete evidence. Current-attempt successful matrix DAG results may reconcile a lagging in-progress Jobs API record; queued, failed, missing and historical executions cannot inherit success.

Plans retain structured full-selection triggers. Descriptive workspace metadata, generated API contracts and Skill reference Markdown have explicit ownership; unknown executable inputs stay conservative. Plans consume validated recent successful dev timing artifacts with a checked-in fallback, bind the complete timing snapshot, and react to recent slow batches. A read-only completed-workflow collector measures final queue and compute time after the normal release activates it on the default branch.

## Alternatives considered

**Run the full CI matrix locally.** This duplicates expensive platform and browser execution and makes every iteration wait for the broadest scope.

**Reuse the last successful commit or timestamps.** Dirty files, new files, partial staging and same-size edits can change the tested content without a useful timestamp or commit transition.

**Treat focused LCOV as full coverage.** Selected tests cannot establish a package-wide threshold or replace complete test inventories.

## Consequences

Developers choose focused behavior tests and receive an explicit local report with pending remote verification. Static receipts save unchanged pre-push work without caching test success. Working inputs are hashed twice to detect edits during verification; unsupported inputs fail visibly instead of silently disappearing.

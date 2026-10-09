# Decision Record: Development verification feedback

Status: implemented

## Problem

Static preflight does not execute product tests or establish coverage. Repeating static commands in a push hook adds latency without discovering changes when their inputs are identical. Uncommitted new source can also be absent from revision-only verification plans.

## Decision

The root `verify` command previews CI selection from the complete working tree and runs explicitly selected behavior tests through the owning coverage executor. Fresh focused reports detect newly added or newly measurable source missing from LCOV. Complete package thresholds and platform acceptance remain CI responsibilities; explicit package coverage is available locally.

Local static checks and the pre-push hook share content-addressed success receipts for deterministic checks. Receipts bind all tracked and non-ignored working inputs, file modes, link targets, commands and the toolchain. Tool identity uses resolved executables and relevant runtime options, so Git/Husky PATH prefixes that resolve to the same tools can reuse evidence. They expire after one day, are written atomically, and cannot be used in CI. Changed inputs during checks reject the result. Staged pre-commit checks retain their independent index semantics. The gate scheduler owns receipts; fingerprint utilities do not import the executing CLI, avoiding a top-level-await cycle when quality checks run directly.

CI collects independent coverage diagnostics even when another task fails, while admission still requires every selected task and complete evidence. Current-attempt successful matrix DAG results may reconcile a lagging in-progress Jobs API record; queued, failed, missing and historical executions cannot inherit success.

Plans retain structured full-selection triggers. Descriptive workspace metadata, generated API contracts and Skill reference Markdown have explicit ownership; unknown executable inputs stay conservative. Plans consume validated recent successful dev timing artifacts with a checked-in fallback, bind the complete timing snapshot, and react to recent slow batches. A read-only completed-workflow collector measures final queue and compute time once it lands on the default branch.

Development Skills keep the everyday feedback loop and verification choices in their entry points. Domain-specific regressions live in linked references, whose relative links are validated recursively. Frontend and Git procedures no longer prescribe a duplicate complete local matrix before every push.

The Oryn integration adopts the upstream [once-per-version review policy](https://github.com/yzxoi/oryn-mini/pull/16) through an immutable runtime pin. Published evidence for an unchanged version prevents duplicate scheduled reviews; source changes remain eligible, and receipt writers remain serialized.

The conversation-process browser suite retains all 73 scenarios across presentation/recovery, disclosure, reading and virtualization batches. They reuse input-addressed static browser fixture compilation while owning separate Homes and a fresh browser context for each test. Both shipped virtualizer entrypoints remain covered. Native paging first releases its setup locator through real input, waits for the observable Latest position and verifies focus before sending the key, instead of assuming a fixed number of frames completes scrolling. Browser timing classification follows local test support imports so extracting a fixture cannot erase its preparation estimate.

## Alternatives considered

**Run the full CI matrix locally.** This duplicates expensive platform and browser execution and makes every iteration wait for the broadest scope.

**Reuse the last successful commit or timestamps.** Dirty files, new files, partial staging and same-size edits can change the tested content without a useful timestamp or commit transition.

**Treat focused LCOV as full coverage.** Selected tests cannot establish a package-wide threshold or replace complete test inventories.

## Consequences

Developers choose focused behavior tests and receive an explicit local report with pending remote verification. Static receipts save unchanged pre-push work without caching test success. Working inputs are hashed twice to detect edits during verification; unsupported inputs fail visibly instead of silently disappearing.

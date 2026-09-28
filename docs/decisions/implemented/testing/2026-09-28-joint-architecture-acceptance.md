# Decision Record: Joint architecture acceptance evidence

Status: implemented

## Problem

Individually passing architecture changes do not establish that attachments, input scheduling, Workspace files, Environment execution and persistence work together. Opt-in Docker suites can exit successfully with every physical scenario skipped, so a successful command alone cannot establish coverage.

## Decision

The CI Environment task declares its seven mandatory physical scenarios in the verification plan. The shared JUnit verifier requires each scenario to pass exactly once and rejects missing, skipped, failed, duplicate or changed evidence. A behavioral planning regression covers Environment source changes, Docker test changes and attachment preparation changes, including installed-runtime verification.

## Alternatives considered

**Trust the test process exit status.** Bun successfully exits when opt-in tests are skipped. That is useful for ordinary package suites but cannot prove the dedicated Docker job exercised physical execution.

**Add a second Environment report parser.** The CI scenario verifier already validates report hashes and actual JUnit results. Reusing it keeps the acceptance rule identical across installed-runtime and Environment jobs.

## Consequences

Renaming or adding a mandatory physical scenario requires updating the CI inventory. Ordinary package tests retain their opt-in behavior; the dedicated Environment job fails closed when its Docker configuration is absent. This gate establishes CI scenario execution, not independent-host or live-model acceptance.

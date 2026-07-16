---
name: testing-guide
description: Design, write, run, and diagnose Synergy tests with Bun, temporary Scope isolation, deterministic fixtures, and behavior-first assertions. Use for TDD, bug regressions, feature tests, migration tests, flaky tests, coverage, package tests, frontend tests, and selecting verification gates.
---

# Test Synergy Behavior

## Define the Invariant First

1. State the observable contract and the failure that would violate it.
2. For a bug or new behavior, write the smallest failing test before the implementation. Skip a new test only for a pure refactor whose existing tests already cover unchanged behavior.
3. Assert public results, state transitions, emitted contracts, permissions, or recovery behavior. Avoid source-text assertions, private call counts, and snapshots of irrelevant structure.

## Choose the Lowest Useful Level

- pure function/schema: inline data and direct calls
- tool/domain behavior: real implementation plus isolated temp directory and Scope context
- persistence/migration: real storage, fresh-install and upgrade fixtures, restart/readback where relevant
- route/SDK: call the route or generated client contract
- session/LLM loop: real session state with deterministic provider/model fixtures
- Web/UI: component/context behavior plus the smallest browser or integration check needed
- package/release: build, pack, and validate the published artifact rather than source layout alone

Inspect two nearby tests and `packages/synergy/test/preload.ts` before introducing a new harness pattern.

For localized UI behavior, use a real Lingui `I18nProvider` with minimal English and Simplified Chinese messages. Assert visible text and accessibility labels after a reactive locale change; do not mock translation calls to return IDs because that hides missing catalogs and stale module-load translations. Keep plugin-author, user, LLM, path, identifier, and raw-error pass-through in the same boundary test as translated host chrome.

## Use Real Isolation

Use `tmpdir()` and `ScopeContext` instead of mocking Storage, Session, or the filesystem. Restore environment variables and singleton state in cleanup hooks. Honor abort signals and dispose processes, Browser pages, servers, and timers.

Provider/model tests use the pinned `test/tool/fixtures/models-api.json` catalog. Update that fixture deliberately; never make deterministic tests depend on the live model catalog or real API keys.

Use a fake or local boundary only where the external system is not the subject of the test. Do not add Jest/Vitest mocks to the Bun suite without an established package-specific reason.

## Run Narrow to Broad

Core runtime commands run from `packages/synergy`:

```bash
bun test test/<domain>/<file>.test.ts
bun run test:changed
bun test
bun run test:coverage
```

Repository gates run from the root:

```bash
bun run typecheck
bun run quality:quick
bun turbo test
bun run quality
```

Localized frontend changes also run:

```bash
bun run --cwd packages/app i18n:extract
bun run --cwd packages/app i18n:check
bun script/localization-check.ts --strict
bun run --cwd packages/app build
```

Extraction must leave tracked PO catalogs unchanged, strict compilation must reject missing Simplified Chinese or invalid ICU messages, and the production build must keep non-English catalogs lazy while excluding development-only pseudo-localization. Exercise a Chinese cold start, rapid switching, catalog-load failure, `html.lang`, keyboard labels, and 375 px layout through an isolated Web/Desktop runtime.

Run the narrow failing test during iteration, then the affected package/domain suite, then `quality:quick`. Run the full suite when the change crosses shared abstractions, persistence, generated contracts, package publication, or release boundaries, or when the user requests it.

Use [Development reference](../../../docs/reference/development.md) and [Open-source quality](../../../docs/operations/open-source-quality.md) for current command ownership. Do not invent a root `bun test`; the root script intentionally rejects that ambiguous command.

## Diagnose Failures

1. Re-run the narrow test alone and capture the first causal failure.
2. Check isolation leaks, stale generated files, timeouts, open handles, environment restoration, ordering, and platform assumptions.
3. Distinguish a product regression from a brittle expectation. Change the test only when the intended public contract is wrong or was asserted at the wrong level.
4. Do not skip, weaken, or quarantine a relevant test merely to make the gate green.

## Handoff

Report the invariant, test location, red/green evidence, commands run, pass/fail counts, unrun gates, platform limitations, and any remaining nondeterminism.

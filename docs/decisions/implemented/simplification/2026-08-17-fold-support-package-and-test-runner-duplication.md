# Decision Record: Fold the support package and shared test runner duplication

Status: implemented

## Problem

Two build/tooling surfaces duplicate logic that already lives in the repo root:

- `packages/script` (`@ericsanchezok/synergy-script`) is a workspace package with a single consumer: `packages/synergy/script/build.ts:16`. Its version/channel computation (`packages/script/src/index.ts:21-48`) duplicates `script/release/shared/runtime.ts:207-208` (identical `0.0.0-${channel}-${timestamp}` format), and its Bun-version guard (`index.ts:12-13`) duplicates `script/check-bun-version.ts:10-12` (used by `.husky/pre-push`). The package is not published (no `version`, no `publishConfig`) and exists only for this one import.
- `packages/app/script/test.ts` (99 lines) and `packages/ui/script/test.ts` (92 lines) implement the same sharded test runner — recursive test collection, coverage-shard handling (`coverage/shards/${shard}`), `Bun.spawn` batches with isolated/browser serial lists, identical failure aggregation; only the per-package test lists differ.

## Decision

- `Script` (build helpers, `retry`, `npmVersionExists`) now lives in `packages/synergy/script/script-identity.ts` next to its sole consumer (`packages/synergy/script/build.ts`). The `packages/script` workspace package, its knip config entry, and the root devDependency are removed.
- Version derivation calls into the canonical `script/release/shared/runtime.ts` (`computeDevVersion` / `computeStableVersion` / `npmVersionExists` / `retry`) instead of re-deriving the format.
- The two per-package test runners now delegate to the shared `runBatchedTests()` helper in `script/shared/test-runner.ts`; `packages/app/script/test.ts` and `packages/ui/script/test.ts` only parameterize their per-package test lists.

## Alternatives considered

- **Keep `packages/script` as a future shared-tooling home** — rejected: a one-consumer support package adds publish/dependency overhead with no second consumer; re-creating it is cheap if one appears.
- **Move the version format into `packages/script` and import from release** — rejected: the release pipeline is the canonical owner; a support package should not own release semantics.
- **Leave the two test runners duplicated** — rejected: they are near-identical 90-100-line scripts whose drift risk is real (one already handles browser serial lists differently); a shared helper is the smallest change that removes the duplication.

## Consequences

- No `@ericsanchezok/synergy-script` reference remains in package.json, bun.lock, knip.jsonc, the workspace list, or coverage-exempt.json; `docs/reference/packages.md` no longer lists the package.
- `bun run build` in `packages/synergy` resolves the folded build helpers; version/channel semantics now come from one place (the release pipeline).
- The shared test runner changes test-infra behavior across two packages; both suites were run before/after the extraction with identical shard layout and pass/fail output.
- Re-creating `packages/script` is cheap if a second consumer of shared build tooling appears; until then the root keeps one fewer workspace package and dependency edge.

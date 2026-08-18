# Decision Record: Remove orphaned diagnostic scripts and dead test assets

Status: implemented

## Problem

Eight tracked files have no consumer in code, workflows, docs, skills, or package scripts:

- `packages/synergy/script/memory-inspect.ts`, `session-memory-forensics.ts`, `library-repair-memory-vectors.ts` — diagnostic utilities with no references anywhere; `library-repair-memory-vectors.ts` additionally writes `library.db` directly, which is destructive if invoked by accident.
- `script/duplicate-pr.ts` — no package script entry, no workflow, no docs reference. It is a personal utility that invokes the SDK.
- `script/hooks` — a pre-husky install script that writes `.git/hooks/pre-push`; the repo now uses husky (`package.json:46` `prepare: "husky"`, live hooks in `.husky/pre-commit` and `.husky/pre-push`).
- `packages/synergy/scripts/build-helper.sh` — a five-line wrapper whose body only runs `bun run scripts/build-helper.ts`; every real consumer (`script/dev.ts:816`, `.github/workflows/build-helpers.yml`, `src/sandbox/readiness.ts`, tests) invokes `build-helper.ts` directly.
- `packages/synergy/test/tool/__snapshots__/tool.test.ts.snap` — pins `tool.ls basic` output of a fixtures directory that no longer exists; no `tool.test.ts` and no `toMatchSnapshot` call exists in the package, and `test/fixtures/` is empty.
- `test-browser/index.html` — a tracked hand-rolled demo page (300+ lines) with zero references anywhere.

One dependency is dead for the same reason: `babel-plugin-macros` (`packages/app/package.json:34`) has no importers — the app uses the lingui vite plugin, not the babel-macros path, and the only relationship in the lockfile is as an optional peer of `@lingui/core`.

## Decision

The eight files above are deleted and `babel-plugin-macros` is removed from `packages/app` devDependencies. `scripts/build-helper.ts` and the sandbox/CI consumers that use it are kept.

Reference checks confirmed no consumers: the worktree and primary skill trees contain no invocations of the removed scripts, and `release-log-workflow` uses its own workflow.

`script/changelog.ts` is kept: `script/release/nodes/create-draft-release.ts:1` imports `buildNotes` and `getLatestRelease` from it (extensionless `../../changelog` import), and that node runs in the `stable-start` release workflow (`.github/workflows/release.yml:111`).

## Alternatives considered

- **Keep `changelog.ts` as an undocumented manual utility** — rejected: an unscripted, unreferenced tool decays silently; history preserves it. This remains the rationale for removing the other eight files; `changelog.ts` itself is retained because the release workflow consumes it.
- **Keep `babel-plugin-macros` to satisfy the lingui optional peer** — rejected: optional peers need not be installed, and no macro import exists in the app.

## Consequences

- The removed filenames have no references outside git history.
- `bun run deadcode` no longer reports `babel-plugin-macros` for `packages/app` and resolves cleanly for the removed scripts.
- `bun run test-layout:check`, `bun run --cwd packages/ui test`, and `bun run decision:check` stay green.

The release workflow keeps its changelog dependency: `script/changelog.ts` remains in place and continues to be imported by `script/release/nodes/create-draft-release.ts`.

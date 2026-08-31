# Decision Record: Cache Prettier and scope generate.ts formatting to its own outputs

Status: implemented

## Problem

`bun dev prepare` spent most of its time formatting rather than building. Measured on a warm checkout: `./script/generate.ts` alone took ~67 s, of which ~50 s was its trailing `bun run ./script/format.ts` — a repository-wide `prettier --write .` over ~1500 files. The scan's only functional job was to format the pipeline's own outputs: `packages/sdk/js/src/gen/` was already formatted by the SDK build's own `prettier --write src`, so the entire repo-wide pass existed for `packages/sdk/openapi.json` — a committed file inside Prettier's scan scope (unlike the transient `packages/sdk/js/openapi.json`, which is `.prettierignore`d) that the server emits with a different array-wrap layout than Prettier's. The same full scan also backed `bun run format` and `bun run format:check` (~55 s), so pre-push, `quality:quick`, and CI hashed and re-parsed every file in the repo on every invocation, unchanged or not.

## Decision

- `script/generate.ts` no longer runs the repository-wide formatter. Its trailing step is `prettier --write packages/sdk/openapi.json` — the pipeline's only output that is committed, inside Prettier's scope, and not already formatted upstream. End-to-end generate time drops from ~67 s to ~13 s, and the produced `openapi.json` is byte-identical to the previous pipeline's when nothing changed (verified by running generate and checking `git status`).
- `script/format.ts`, the root `format:check` script, and the SDK build's `prettier --write src` all run with `--cache --cache-strategy content`. Prettier hashes file contents and skips unchanged files entirely, so a warm repo-wide run takes ~8 s instead of ~55 s. The cache lives in Prettier's default `node_modules/.cache/prettier/` location (inside the gitignored `node_modules`). The `content` strategy is chosen over `metadata` because git checkouts, rebases, and worktree switches rewrite mtimes without changing contents.
- `./script/format.ts` remains the repository's full-tree formatter and the canonical fix command for `format:check` failures; the generate pipeline merely stops triggering it.

## Alternatives considered

- **Keep the full-repo scan in generate.ts and rely on the cache flag alone** — rejected: the scan's only real targets are the pipeline's own outputs, so scoping it is deterministically fast regardless of cache state (first run, cold cache, cross-worktree), while cache-only still pays a full-tree hash walk inside a pipeline step that has no business looking at the rest of the repo.
- **Make the server emit Prettier-identical JSON for `packages/sdk/openapi.json`** — rejected: it would duplicate Prettier's print-width layout rules inside the OpenAPI generator and drift on every Prettier upgrade; a targeted `prettier --write` on the single committed artifact yields the same bytes with no rule duplication.
- **Turbo task caching for the prepare steps** — deferred: skipping whole subtrees (`build`, `generate`) on unchanged inputs is a separate decision with its own trade-offs (the App build label embeds `git rev-parse HEAD`, so cached outputs can carry a stale revision), not a substitute for making each step itself cheap.

## Consequences

- The warm `bun dev prepare` path loses ~54 s of formatting: `generate.ts` runs about 5x faster end to end, and every explicit `format:check` (pre-push hook, `quality:quick`, CI) runs about 7x faster on an unchanged tree.
- `generate.ts` no longer incidentally reformats contributors' unrelated working-tree files as a side effect; repo-wide formatting remains the job of `bun run format`, with `format:check` as the enforcement gate in the pre-push hook and CI — which is where unformatted files should surface, not inside the SDK regeneration step.
- Formatting behavior is unchanged: the same Prettier version with the same config decides every file's layout. The cache only skips files whose hash matches the previous run and never substitutes a stored output.
- First runs and cold caches pay the same full scan as before; this change optimizes the repeated-invocation path that dominates day-to-day development.

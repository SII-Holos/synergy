# Decision Record: Prettier ignores git-tracked symlink checkout artifacts

Status: implemented

## Problem

`apps/web/src/custom-elements.d.ts` is a git-tracked symlink. On checkouts with `core.symlinks=false` (Windows defaults), git materializes it as a plain file whose entire content is the target path `../../../packages/ui/src/custom-elements.d.ts`. Prettier tries to parse that file as TypeScript, fails, and every `format:check` — including the pre-push gate — fails on such checkouts. `.prettierignore` already carried the same workaround for the symlinked `apps/web/public/` assets, but the `.d.ts` symlink was missed.

## Decision

Git-tracked symlinks that prettier would otherwise read are listed in `.prettierignore`, with a comment naming the class of artifact. `apps/web/src/custom-elements.d.ts` is added.

## Alternatives considered

**Require `core.symlinks=true` (developer mode / elevated Git) on Windows.** Pushes per-machine setup onto every contributor and does not help CI or sandboxed checkouts. Rejected.

**Replace the symlink with a real re-export file.** Changes the repository layout and the canonical-source relationship between `packages/ui` and `apps/web`, which deserves its own decision outside this fix. Rejected.

**Pass per-invocation ignore flags in `format:check`.** Duplicates ignore state outside `.prettierignore` and does not cover other prettier entry points. Rejected.

## Consequences

`format:check` passes on symlink-degraded checkouts at the cost of one more ignore entry. The policy anchor is the comment in `.prettierignore`: any new git-tracked symlink that lands as a path-only plain file must be added there, or Windows checkouts will fail the format gate again.

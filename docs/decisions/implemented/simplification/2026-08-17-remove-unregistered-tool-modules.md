# Decision Record: Remove unregistered tool modules and their dead UI renderers

Status: implemented

## Problem

Four backend tool modules ship in `packages/synergy/src/tool` but no agent can invoke them, plus dead presentation layers for two of them:

- `BatchTool` (`src/tool/batch.ts`) is imported at `src/tool/registry.ts:7` but appears in no builtin array entry (`registry.ts:340-458`); its own `DISALLOWED` set (`batch.ts:5-6`) has no other readers. Only consumer: `test/tool/batch.test.ts`. Companion prompt asset `src/tool/batch.txt`.
- `DiagramTool` (`src/tool/diagram.ts`, 515 lines) has its registry import commented out (`registry.ts:101`, "已注释，待重构") and no other import anywhere.
- Eight `agora-*.ts` modules (1,455 lines) plus eight `agora-*.txt` prompt assets: every import is commented out (`registry.ts:61-68`, `taxonomy.ts:201-208`, enforcement gate, and `packages/ui/src/components/message-part.tsx:1196-1226`). Remaining references are comment-level only.
- `src/tool/todoread.txt` has no importer; `todo.ts:32-34` uses a hard-coded one-line description.

All of these have been unreachable since the initial open-source release commit; the commented-out registry entries document intent but the comment noise is itself maintenance cost.

## Decision

Delete the dead modules and their assets: `src/tool/batch.ts`, `batch.txt`, `test/tool/batch.test.ts`, `src/tool/diagram.ts`, the eight `agora-*.ts` files and eight `agora-*.txt` files, and `src/tool/todoread.txt`. Remove the commented-out import/registration remnants in `registry.ts`, `taxonomy.ts`, the enforcement gate, and `message-part.tsx`.

The UI keeps three registered renderers whose backend tools no longer exist: the `diagram` renderer in `packages/ui/src/components/tool/renders/special.tsx:4-60`, the legacy `qzcli_*` tool registrations in `packages/ui/src/components/tool/renders/batch.tsx` (their backend `qzcli_*` tools are gone from `registry.ts` and `taxonomy.ts`), and the `diagram` case in `message-part.tsx:774-778`. Remove those registrations plus the now-dead `packages/ui/src/components/diagram.tsx`/`diagram.css` files. Keep the `worktree_enter`/`worktree_leave`/`worktree_list` registrations in `batch.tsx` — their backend tools are registered (`registry.ts:416-418`) and live.

Keep `src/tool/ls.ts`: `ListTool` is unregistered in `ToolRegistry` but has a production consumer via `src/session/input.ts:32-34`.

## Alternatives considered

- **Re-register `batch`/`diagram`/`agora-*`** — rejected: no product owner has claimed them since the initial release; reactivating them is a feature decision that needs taxonomy, permission, and Web presentation work, not a cleanup.
- **Keep the commented-out registry entries as a roadmap** — rejected: git history preserves the removed code and the commented imports; live comment scaffolding drifts from the real registry and confuses `add-tool` workflows.

## Consequences

- `bun test packages/synergy/test/tool/batch.test.ts` removed along with the module; remaining tool tests green.
- `grep` finds no `BatchTool`, `DiagramTool`, or `Agora*` references outside git history.
- `bun run deadcode` reports no new findings for `packages/synergy`.
- `bun run --cwd packages/ui test` green after renderer removal (including CSS token-contract tests if they reference the removed files).
- The `diagram` UI renderer is exported from the `packages/ui` public `./*` exports map; removal shrinks that public surface. No in-repo or plugin-package consumer exists (`git grep` finds none), and the same class of deletion was already accepted for other unused components (#1184). Out-of-repo consumers of `@ericsanchezok/synergy-ui/diagram` would break; accepted for a cleanup of an unreachable tool, recoverable from history.
- Dead permission/capability entries removed in the same pass: `diagram` from `SYNERGY_PERMISSION_CAPABILITY` and `ACCUMULATING_TOOLS`, plus the legacy `batch` permission mapping. `doom_loop` stays — it has live consumers.
- Stale coverage exemptions removed from `script/coverage-exempt.json` (five `src/agora/*` files, `src/components/diagram.tsx`, `src/components/tool/renders/special.tsx`); `bun script/coverage-check.ts --validate` passes.
- App-owned i18n catalogs regenerated via `bun run --cwd packages/app i18n:extract`; stale descriptor keys removed from `en`/`zh-CN`/`pseudo` catalogs and from `packages/app/test/script/i18n-check.test.ts` expectations.

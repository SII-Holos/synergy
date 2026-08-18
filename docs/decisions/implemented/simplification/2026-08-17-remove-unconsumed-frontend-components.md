# Decision Record: Remove unconsumed frontend components and stores

Status: implemented

## Problem

Six frontend modules in `packages/app` and `packages/ui` have zero production consumers and no live product owner:

- `packages/app/src/context/plugin-host.tsx` (`SandboxPluginHostProvider`/`useSandboxPluginHost`): zero references repo-wide outside the file; the real host is `packages/app/src/plugin/host.tsx`.
- `packages/ui/src/components/session-message-rail.tsx` + `message-nav.tsx`: the rail is the only importer of `message-nav`, and nothing imports the rail. `message-nav.css` was still wired in `packages/ui/src/styles/index.css:32`.
- `packages/ui/src/components/session-resonance-popover.tsx`: only self-imports its CSS; the sole other reference was a CSS token-integrity test entry (`packages/ui/test/css-token-integrity.test.ts:15,269`).
- `packages/ui/src/components/typewriter.tsx`: no JSX usage; three tests mocked the module defensively (`test/components/session-turn-{activity,projection,timeline}.test.ts`) but nothing imported it.
- `packages/ui/src/hooks/create-typewriter.ts`: consumers were only the `hooks/index.ts` barrel and its own test.
- `packages/ui/src/components/{avatar,select,favicon,diff-ssr}.tsx`: zero production or test references. The app uses native `<select>` (`packages/app/src/plugin/components/declarative-settings-form.tsx:39`) and `diff.tsx` imports `@pierre/diffs` directly rather than `diff-ssr`. `avatar.css`/`select.css`/`typewriter.css` remained wired in `styles/index.css:10,37,50`.

## Decision

Deleted the six modules, their CSS files (except any CSS still imported by live components), the `create-typewriter` barrel re-export and test, and the `session-resonance-popover.css` entry in `css-token-integrity.test.ts`. `packages/ui/src/styles/index.css` no longer imports the removed CSS files. The defensive `typewriter` mock lines were removed from the three session-turn tests, along with the now-dead `coverage-exempt.json` globs, the `localization-allowlist.json` entry, and the `semantic-icon.test.ts` exception for `select.tsx`.

Kept `packages/ui/src/hooks/create-animated-number.ts` (used by `tool-result-body.tsx:12`), `create-auto-scroll`, and `use-filtered-list` — they are live.

## Alternatives considered

- **Keep dead primitives as a public component library** — rejected: `packages/ui` exports `./*`, so unconsumed components are speculative API surface, not a library investment; no plugin or out-of-repo consumer is known.
- **Keep `typewriter` because tests mock it** — rejected: the mocks are defensive; deleting the module lets the three mock lines be removed too.
- **Fold `diff-ssr` into `diff.tsx`** — rejected: `diff.tsx` already uses `@pierre/diffs` directly; `diff-ssr` adds no shared behavior.

## Consequences

- `grep` finds no `useSandboxPluginHost`, `SessionMessageRail`, `MessageNav`, `SessionResonancePopover`, `<Typewriter`, `createTypewriter`, or imports of `avatar`/`select`/`favicon`/`diff-ssr` outside git history.
- `styles/index.css` no longer imports the removed CSS files; `css-token-integrity.test.ts` and `visual-token-contract.test.ts` pass.
- `bun run --cwd packages/ui test` and `bun run --cwd packages/app test` are green.
- Deletion shrinks the public `@ericsanchezok/synergy-ui` export surface; out-of-repo consumers of these components would break. No in-repo consumer exists, and the components carry no documented product role.
- The `freshness`-style refactor candidates (collapsing `SyncResourceFreshness`/`SessionPartSnapshotFreshness`/`scope-reconnect-recovery`) are intentionally out of scope: they are live, load-bearing sync machinery and need a separate design decision.

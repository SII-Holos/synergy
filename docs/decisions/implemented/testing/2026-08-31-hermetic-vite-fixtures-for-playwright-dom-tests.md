# Decision Record: Hermetic Vite fixtures for Playwright DOM tests

Status: implemented

## Problem

The Coverage CI job (`bun script/gates.ts ci-coverage`) runs `packages/app` tests with no build step, so workspace packages that publish their `import` condition from a gitignored `dist/` are unresolvable inside Playwright DOM-test fixtures. `packages/plugin`'s exports map serves `@ericsanchezok/synergy-plugin/theme` from `dist/theme/index.js`, which a fresh checkout lacks; the real Lingui runtime additionally pulls `@messageformat/parser` (CJS) through `@lingui/message-utils`, whose named `parse` import breaks under Vite's on-demand dependency optimization. The `open-in-browser.dom.test.ts` suite from #1290 failed in Coverage CI (page 500 → 30s selector timeouts, reported as `ECONNREFUSED` in the gate's failure signals) because its fixture lacked the mitigations that `ThemePicker.behavior.test.tsx` had already accumulated over three earlier fixes (`e7fbc3974`, `43c4905ad`, `cd63660e5`). The same failure class had already surfaced there and was fixed per-file, but no shared rule captured it, so the next Playwright fixture re-introduced it.

## Decision

Playwright DOM-test fixtures that boot a Vite dev server must be hermetic against a no-build checkout:

- Alias workspace-package entries whose `import` condition points at gitignored `dist/` output to their source entry (`packages/plugin/src/theme/index.ts` for the theme contract).
- Resolve runtime packages that break under dependency pre-bundling (Lingui's `@messageformat/parser` chain) to minimal fixture-local stubs when the suite asserts behavior unrelated to i18n rendering, or add them to `optimizeDeps.include` when the real runtime is the subject.
- Set `optimizeDeps.include` for the Solid runtime/JSX runtime/zod with `noDiscovery: true` so the optimizer never re-runs mid-load and reloads the page.
- Scope `cacheDir` to the fixture temp directory so sibling Playwright servers sharing `packages/app/node_modules/.vite` cannot invalidate each other's optimizer cache.
- `warmupRequest` the fixture entry before launching the browser, and surface page/console/HTTP errors in the failure message instead of a bare 30s selector timeout.
- Register the suite in the package's `playwrightIsolated` list so bun's worker reaping cannot kill its Chromium process mid-suite.

## Alternatives considered

**Rely on `bun dev prepare`/turbo `^build` to materialize `dist/` before the Coverage job.** Rejected: `ci-coverage` deliberately runs no build step to keep the gate cheap; depending on a build artifact makes the gate's validity a function of CI pipeline ordering instead of the checkout itself.

**Fix `@messageformat/parser` pre-bundling once globally.** Rejected: it would require either an app-wide `optimizeDeps` include (which the production build does not use) or a Vite plugin shim, both broader than the fixture's needs and untested outside DOM fixtures.

**Stub only `@lingui/core`/`@lingui/solid` via alias and keep the real locale context.** Rejected: the fixture asserts toolbar chrome and click behavior, not translation rendering; the repo's own guidance already prefers minimal stubs at the boundary that is not the subject of the test.

## Consequences

`open-in-browser.dom.test.ts` passes in the Coverage job and locally without a plugin build, and the fixture reports real module-graph errors in `beforeAll` instead of timing out. The `testing-guide` skill now carries the hermetic-Vite-fixture checklist so future Playwright DOM tests get the mitigations up front instead of rediscovering them per file. The cost is a small per-fixture configuration block (alias + optimizeDeps + cacheDir + warmup) that each new DOM suite must include or consciously waive.

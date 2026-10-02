# Browser Runtime

Desktop Browser backend state, page collections, persistent identities, permissions, tools, routes, lifecycle and recovery.

Use explicit page IDs and immutable profile identity with independent human selection. Native WebContentsView is the product presentation. Browser cleanup consumes generic session terminal events; native hosting stays in apps/desktop and shared schemas in packages/browser-core.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `presets/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/browser-runtime` from the repository root; `bun script/pack-workspace.ts packages/browser-runtime .artifacts/packages` builds its workspace dependency closure.

Call `registerBrowser()` before opening Harness and wire `disposeBrowser()` into `RuntimeServices.disposeExtensions`. Registration and suspended session reads do not allocate native pages. HTTP routes remain a separate host contribution.

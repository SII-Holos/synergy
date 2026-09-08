# Computer Runtime

Computer broker operations, tools, host attachment and transport lifecycle.

Native drivers belong to apps/desktop; shared messages belong to packages/computer. Never import native Desktop implementations into the broker.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/computer-runtime` from the repository root; `bun script/pack-workspace.ts packages/computer-runtime .artifacts/packages` builds its workspace dependency closure.

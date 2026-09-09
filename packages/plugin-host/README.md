# Plugin Host

Plugin processes, discovery, configuration, trust, permissions and capability-gated Host Services.

Use the public plugin author contracts. Host Services expose actually registered capabilities; avoid importing every product domain from the host.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/plugin-host` from the repository root; `bun script/pack-workspace.ts packages/plugin-host .artifacts/packages` builds its workspace dependency closure.

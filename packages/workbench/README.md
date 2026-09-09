# Workbench

Product Projects, statistics and performance read models, activity presentation and notifications.

Keep product read models out of core execution accounting. Session and rollout evidence remain canonical in Harness.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/workbench` from the repository root; `bun script/pack-workspace.ts packages/workbench .artifacts/packages` builds its workspace dependency closure.

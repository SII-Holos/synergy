# Workbench

Product Projects, statistics and performance read models, activity presentation, task execution details and notifications.

Keep product read models out of core execution accounting. Session and rollout evidence remain canonical in Harness.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `presets/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/workbench` from the repository root; `bun script/pack-workspace.ts packages/workbench .artifacts/packages` builds its workspace dependency closure.

Task execution queries live in `src/execution` and consume public Harness Rollout and usage exports. The scoped session API exposes summary, process/records trajectory, type-specific node detail and versioned content ranges/sections/search/download. Financial presentation is shared with statistics; formulas and immutable prices remain in Harness. Verify ownership, lifecycle, paging, grouped purposes, retained children and large content with `bun test test/execution`.

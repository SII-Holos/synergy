# Notes

Note documents, content rules, backend service, tools, routes, configuration and migrations.

Expose content operations for workflow consumers. Tool and route handlers use the same domain service and preserve version/conflict semantics.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/note` from the repository root; `bun script/pack-workspace.ts packages/note .artifacts/packages` builds its workspace dependency closure.

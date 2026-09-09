# Library

Knowledge storage, memory and experience retrieval, embedding, encoding, Chronicler, tools, routes, configuration and migrations.

Register the capability explicitly. Model work must retain cancellation, usage, budget and execution provenance through Harness. Core context receives a typed contribution without owning retrieval policy.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/library` from the repository root; `bun script/pack-workspace.ts packages/library .artifacts/packages` builds its workspace dependency closure.

Call `registerLibrary()` before opening Harness and wire `disposeLibrary()` into `RuntimeServices.disposeExtensions`. Harness drains execution and background jobs before this cleanup closes the embedding runtime and database.

# Workflows

Blueprint, Light Loop, Lattice, Agenda, Boss and their commands, tools, routes and migrations.

Declare required knowledge, project, automation and content services. Missing services must fail explicitly; do not quietly present a partial workflow as complete.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/workflows` from the repository root; `bun script/pack-workspace.ts packages/workflows .artifacts/packages` builds its workspace dependency closure.

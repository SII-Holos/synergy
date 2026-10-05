# Notes

Note documents, content rules, backend service, tools, routes, configuration and migrations.

Expose content operations for workflow consumers. Tool and route handlers use the same domain service and preserve version/conflict semantics.

Hosts with their own tool catalog select `noteTools()` and call `registerNoteToolInputHistory()` from `./tools` during Runtime registration. History registration retains the owning session migrations without enabling product tool groups. Full Note composition uses `registerNote()` from `./register`.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `presets/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/note` from the repository root; `bun script/pack-workspace.ts packages/note .artifacts/packages` builds its workspace dependency closure.

# Notes

Note documents, content rules, backend service, tools, routes and migrations.

Expose content operations for workflow consumers. Tool and route handlers use the same domain service and preserve version/conflict semantics.

Document kinds register through `NoteDocumentKinds` before Runtime startup. A kind owner contributes its API fields, tool inputs, guidance and write policy. Note alone exposes ordinary notes; documents owned by an unavailable component stay in storage and are absent from list, search, read, export and mutation surfaces. Ordinary edits preserve unknown stored extension fields, and reinstalling an owner restores its documents. Blueprint owns the Blueprint kind and its execution metadata.

The owner of a document kind also owns its persisted upgrades. Note retains historical migration IDs but converts only ordinary documents. Its Home-scope catch-up uses a new receipt, preserves unknown fields, and fails without overwriting either record when legacy and current IDs conflict.

Hosts with their own tool catalog select `noteTools()` and call `registerNoteToolInputHistory()` from `./tools` during Runtime registration. History registration retains the owning session migrations without enabling product tool groups. Full Note composition uses `registerNote()` from `./register`.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `presets/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/note` from the repository root; `bun script/pack-workspace.ts packages/note .artifacts/packages` builds its workspace dependency closure.

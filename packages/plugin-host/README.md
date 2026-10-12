# Plugin Host

Plugin processes, discovery, configuration, trust, permissions and capability-gated Host Services.

Use the public plugin author contracts. Host Services expose actually registered capabilities; avoid importing every product domain from the host.

Pre-bootstrap selection migration v2 expands old Workflows and Connections component roots into explicit capability and bridge roots. Old Connections selections retain their former Workflows dependency closure. New preset packages keep their current declared closure. Upgrade plans preserve unrelated roots and pins, reuse the package-manager lock, retain API4 grants, and keep previous generations available to running workers. Staging or activation failures leave the active generation unchanged.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `presets/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/plugin-host` from the repository root; `bun script/pack-workspace.ts packages/plugin-host .artifacts/packages` builds its workspace dependency closure.

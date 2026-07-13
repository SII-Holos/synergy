# Public Plugin SDK Rules

This package is the published plugin-author contract. Load `change-plugin-runtime` and read [Plugin documentation](../../docs/plugins/README.md) before changing it.

- Keep this package independent from `packages/synergy` private runtime modules. Public definitions, generated-manifest schemas, capabilities, contributions, contexts, tools, UI contracts, artifacts, and version helpers must remain usable by third-party plugins.
- Infer TypeScript types from the public schemas and preserve stable IDs, defaults, validation errors, and export paths. A host-only implementation detail does not belong in the public manifest.
- Capability declarations are Host Service ceilings consumed by approval and enforcement. Do not restore the old nested permission model or imply control over direct OS access.
- Preserve tool result, hook, shell, UI API-major, and artifact contracts across Bun source exports and built `dist` output.
- Plugin API 3 has no old-package compatibility path. Record breaking migration facts under `docs/migrations/` and keep the public package on one current contract.

Run `bun run typecheck` and `bun run build`, then the focused host/plugin-kit tests and root `bun run package:check` plus `bun run quality:quick`. Inspect the built package and public exports, not only source compilation.

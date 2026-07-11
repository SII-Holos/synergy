# Public Plugin SDK Rules

This package is the published plugin-author contract. Load `change-plugin-runtime` and read [Plugin documentation](../../docs/plugins/README.md) before changing it.

- Keep this package independent from `packages/synergy` private runtime modules. Public manifests, permissions, hooks, tools, UI contributions, artifacts, paths, policies, and version helpers must remain usable by third-party plugins.
- Infer TypeScript types from the public schemas and preserve stable IDs, defaults, validation errors, and export paths. A host-only implementation detail does not belong in the public manifest.
- Capability declarations are ceilings consumed by approval and enforcement. Keep public permission types aligned with shared capability metadata and host validation without exposing credentials or host internals.
- Preserve tool result, hook, shell, UI API-major, and artifact contracts across Bun source exports and built `dist` output.
- Add migration guidance before breaking a shipped manifest or import path. Do not add silent compatibility coercions that the host cannot validate consistently.

Run `bun run typecheck` and `bun run build`, then the focused host/plugin-kit tests and root `bun run package:check` plus `bun run quality:quick`. Inspect the built package and public exports, not only source compilation.

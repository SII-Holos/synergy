# lsp Package

Own the lsp implementation, configuration, lifecycle, tools and transport contributions. Register contributions before opening the Harness. Import other packages only through declared public exports.

Tests live under `test/` and use the shared isolated-home support. Run `bun run typecheck`, the affected tests, and root dependency and package checks. Preserve existing configuration keys, tool identifiers, cancellation, permissions and stored data.

LSP resources follow Workspace binding generations. Own server preparation, native process admission, cancellation and whole-tree cleanup. Retire idle clients under write contention and preserve diagnostics for lazy restart. Run `bun test test/lsp test/workspace-file` for native ownership changes.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

# code-tools Package

Own the code-tools implementation, configuration, lifecycle, tools and transport contributions. Register contributions before opening the Harness. Import other packages only through declared public exports.

Tests live under `test/` and use the shared isolated-home support. Run `bun run typecheck`, the affected tests, and root dependency and package checks. Preserve existing configuration keys, tool identifiers, cancellation, permissions and stored data.

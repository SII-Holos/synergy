# link-client Package

Own the link-client implementation, configuration, lifecycle, tools and transport contributions. Register contributions before opening the Harness. Import other packages only through declared public exports.

Tests live under `test/` and use the shared isolated-home support. Run `bun run typecheck`, the affected tests, and root dependency and package checks. Preserve existing configuration keys, tool identifiers, cancellation, permissions and stored data.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Keep published `synergy` component metadata aligned with the factory version, requirements and packaged entry. Component CLI contributions belong in `src/cli-adapter.ts` when this owner supplies commands; keep their handlers lazy and independent of the complete product.

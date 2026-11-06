# computer-runtime Package

Computer broker operations, tools, host attachment and transport lifecycle. Native drivers belong to apps/desktop; shared messages belong to packages/computer-protocol. Never import native Desktop implementations into the broker. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

The route imports `hono-openapi`, whose optional peer `@hono/standard-validator` is a required static runtime import; declare it directly so this package installs without the full server.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Keep published `synergy` component metadata aligned with the factory version, requirements and packaged entry. Component CLI contributions belong in `src/cli-adapter.ts` when this owner supplies commands; keep their handlers lazy and independent of the complete product.

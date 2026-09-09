# computer-runtime Package

Computer broker operations, tools, host attachment and transport lifecycle. Native drivers belong to apps/desktop; shared messages belong to packages/computer. Never import native Desktop implementations into the broker. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

The route imports `hono-openapi`, whose optional peer `@hono/standard-validator` is a required static runtime import; declare it directly so this package installs without the full server.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

# server Package

Own the reusable HTTP server, core routes, transport middleware, and OpenAPI generation. Product Runtime registers optional route contributions before the first Server.App() call. Read the root AGENTS.md and the owning architecture document before changes.

- Keep product domain routes in their owning packages and mount them from Product Runtime; this package depends only on harness, runtime-local, and util.
- Preserve route contribution order, Scope middleware, authentication, snapshot headers, and OpenAPI operation IDs.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

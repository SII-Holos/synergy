# note Package

Note documents, content rules, backend service, tools, routes, configuration and migrations. Expose content operations for workflow consumers. Tool and route handlers use the same domain service and preserve version/conflict semantics. Independent hosts compose the package through `registerNote()` from `./register`; routes and CLI presentation are separate exports. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

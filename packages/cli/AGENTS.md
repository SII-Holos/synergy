# cli Package

Own the cli implementation and its public exports. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Keep `runCli()` as the sole parser. Product runtime injects command metadata, a runtime factory and nested `dataCommands`; core CLI must not import product implementation packages. Test command-load failures and preserve send cancellation and recording-error exit codes.

# plugin-host Package

Plugin processes, discovery, configuration, trust, permissions and capability-gated Host Services. Use the public plugin author contracts. Host Services expose actually registered capabilities; avoid importing every product domain from the host. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

File-capable invocations pin canonical Workspace generations. Restore the invocation async context for every IPC Host callback, drain Host work before releasing ownership, and preserve native file conflicts. Verify with `bun test test/plugin-runtime/workspace-context.test.ts test/plugin/tool-invocation.test.ts test/plugin/shell-host-service.test.ts`.

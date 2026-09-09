# runtime-local Package

Own the runtime-local implementation and its public exports. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Keep lifecycle implementation in harness and local capability registration here. Session HTTP handlers and in-process clients share `session-api.ts`; preserve Scope ownership, durable inbox scheduling and cancellation. Do not import CLI, HTTP-server or product implementation packages.

- Own bundled model SDK factories and custom SDK loading in `src/provider/sdk-registry.ts`; register them through `registerLocalRuntime()` in host and agent workers.
- Own native PTY, filesystem watchers, OS sandbox backends, helper Rust sources and packaging assets. Register `SandboxHost` and the `file-watcher` Scope startup contribution explicitly; keep permission policy and generic wrapper types in harness.

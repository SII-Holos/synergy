# Shared Test Support

This private package owns deterministic test environments, the pinned model catalog, and shared Scope fixtures. Consumers use it only through devDependencies; production code must never import it.

- Load `testing-guide` before changing isolation or fixture behavior.
- `preload` establishes a positive `SYNERGY_TEST_HOME` and fixture root before any core import. It does not initialize core or install a provider hook.
- Harness initialization and in-process AgentTurn hooks belong to harness test support. Shared fixtures receive their Scope and configuration bindings explicitly and never import the harness.
- Spawn-based orchestrators use `createIsolatedTestEnv()` and pass its environment to every child. Never bypass TestHomeGuard or use the running product home.
- Fixtures stay under `SYNERGY_TEST_ROOT` until owned asynchronous work settles. Dispose child processes, timers, and runtimes before deleting the process fixture root.
- Keep the pinned model catalog deterministic; source and release builds may resolve its exported JSON path without initializing test code.

Run `bun run test`, `bun run typecheck`, and `bun run test:coverage`. Test files belong under `test/`; root coverage policy owns thresholds and exemptions.

# Synergy test support

Private development-only helpers shared by runtime and domain tests. Production packages must not depend on this package.

| Export                                           | Responsibility                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ericsanchezok/synergy-testing/env`             | Creates a temporary home and fixture root for a child process, returns its explicit environment and cleanup function. No core imports or process-global mutation.                             |
| `@ericsanchezok/synergy-testing/preload`         | Bun test preload: isolates the current process, seeds the pinned model catalog, clears provider credentials, disables background downloads, and registers cleanup. Does not load the harness. |
| `@ericsanchezok/synergy-testing/fixture`         | `createFixture()` and Git helpers. The owning harness binds real Scope and config operations; no harness dependency is loaded here.                                                           |
| `@ericsanchezok/synergy-testing/models-api.json` | Pinned model catalog shared with source and release builds. Reading the asset does not initialize tests.                                                                                      |

Packages set their Bun `[test].preload` to the environment preload for ordinary domain tests or the harness-owned preload for suites that require the legacy call-style provider seam. Pure protocol tests need neither. A local `test/preload.ts` may import the selected export and then initialize only the owning domain. Do not load the complete product registration from shared test support.

Spawn-based CI and coverage runners import `createIsolatedTestEnv`, pass the returned `env` to each child, await child termination and drain output, then call `dispose`. Bun workers require the positive `SYNERGY_TEST_HOME` marker even when they do not inherit preload execution. Never substitute `SYNERGY_ALLOW_REAL_HOME` for isolation.

The bound `tmpdir()` retains its directory under the process fixture root after lexical disposal because Scope-owned asynchronous work may still reference it. Dispose owned runtime resources before process cleanup. Worker-path tests do not install the in-process hook automatically; suites using the compatibility preload must explicitly remove and restore that hook when exercising worker execution.

Run `bun run test`, `bun run typecheck`, and `bun run test:coverage` from this package.

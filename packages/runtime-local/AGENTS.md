# runtime-local Package

Own the runtime-local implementation and its public exports. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

Keep lifecycle implementation in harness and local capability registration here. Local Host captures home and environment once; `createLocalClient` requires its Runtime Handle and explicit Scope selector. Worker modules export startup functions and activate only at their selected entrypoint. Session HTTP handlers and in-process clients share `session-api.ts`; preserve Scope ownership, durable inbox scheduling and cancellation. Do not import CLI, HTTP-server or product implementation packages.

- Own bundled model SDK factories and custom SDK loading in `src/provider/sdk-registry.ts`; register them through `registerLocalRuntime()` in host and agent workers.
- Own native PTY, filesystem watchers, OS sandbox backends, helper Rust sources and packaging assets. Build the bounded PTY library with `bun script/build-pty.ts`; validate byte drainage and ownership with `bun test test/process/native-pty.test.ts test/process/pty.test.ts`. Register `SandboxHost` and the `file-watcher` Scope startup contribution explicitly; keep permission policy and generic wrapper types in harness.
- Linux watcher preparation and release assets use `script/build-watcher.ts` and its pinned source patch. Validate the compiled binding and signal recovery; an unused C++ source edit does not fix the installed watcher.

Workspace removal and automatic reclamation share the lifecycle gate and native retirement claim. Git/setup processes use the Workspace process owner; short metadata mutations must not reserve a read-only turn as a writer. Preserve active users, on-disk lock ownership, and unverified local commits. Validate workspace changes with `bun test test/workspace` plus the Product Runtime worktree suites.

Native Workspace coordination owns canonical-root overlap and process identity fencing across Runtime instances. Launchers bind process claims before activating commands and retain ownership through actual exit. Windows Job Objects, macOS coalitions and Linux subreaper completion receipts supply native liveness; native workers own stream drainage independently; validate both with `bun test test/process/owned-process.test.ts test/workspace/bash-footprint.test.ts` and the Windows-owned process suites on Windows.

Workspace file indexes, native subscriptions and edit evidence follow the resolved Workspace generation. Configuration subscriptions remain Scope-owned. File events carry Workspace identity and the committed content version; test sibling directories with `bun test test/workspace-file/isolation.test.ts`.

First-party native integrations use the declared `process/owned-process`, `file/mutation` and `file/link` exports for native process ownership, byte-version validation and preservation of native symbolic-link kinds. They must still acquire Workspace claims before activation; the process module does not infer a writable footprint.

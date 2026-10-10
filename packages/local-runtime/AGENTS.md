# local-runtime Package

Own native execution, reload, CLI host adapters and public exports.

- Domain tools, routes, config and migrations stay with implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run typecheck, affected tests and root package/dependency checks.

Lifecycle stays in Harness; local capabilities register here. Local Host snapshots home and environment; `createLocalClient` requires its Runtime Handle and explicit Scope selector. Workers export startup functions activated only at selected entrypoints. HTTP handlers and in-process clients share `session-api.ts`; preserve Scope ownership, durable Inbox scheduling and cancellation. Do not import CLI, HTTP-server or product implementations.

- Own bundled model SDK factories and custom SDK loading in `src/provider/sdk-registry.ts`; register them through `registerLocalRuntime()` in host and agent workers.
- Own native/Docker Environment providers, Executor transport and receipts. Reuse `OwnedProcess` and Workspace coordination; release durable claims only after saved output and files. Validate `bun test test/environment test/workspace/coordinator.test.ts` and the Docker integration described in the package README.
- Own native PTY, Linux process ownership, filesystem watchers, OS sandbox backends, helper Rust sources and packaging assets. Published modules resolve native resources through platform optional dependencies. Build the native library with `bun script/build-pty.ts`; validate byte drainage and ownership with `bun test test/process/native-pty.test.ts test/process/pty.test.ts test/process/owned-process-linux.test.ts`. Register `SandboxHost` and the `file-watcher` Scope startup contribution explicitly; keep permission policy and generic wrapper types in harness.
- Linux watcher preparation and release assets use `script/build-watcher.ts` and its pinned source patch. Validate the compiled binding and signal recovery; an unused C++ source edit does not fix the installed watcher.

Workspace removal and reclamation share the lifecycle gate and native retirement claim. Git/setup commands use the Workspace process owner; short metadata mutations cannot reserve read-only turns as writers. Preserve active users, on-disk locks and unverified commits. Run `bun test test/workspace` and Presets worktree suites.

Workspace coordination owns physical overlap and process identity across Runtimes. Bind claims before commands; retain ownership through actual exit. Windows Job Objects, macOS coalitions and Linux subreaper receipts provide liveness; native workers drain streams independently. Validate `bun test test/process/owned-process.test.ts test/workspace/bash-footprint.test.ts` and Windows-owned suites on Windows.

Workspace file indexes, native subscriptions and edit evidence follow the resolved Workspace generation. Configuration subscriptions remain Scope-owned. File events carry Workspace identity and the committed content version; test sibling directories with `bun test test/workspace-file/isolation.test.ts`.

Use public `process/owned-process`, `file/mutation`, `file/link` and `file/rename` exports. Preserve byte versions, native link kinds and exclusive publication. Snapshots use Harness link encoding. Acquire resource pins before activation; Sandbox grants never imply writer exclusion. Versioned Executor inputs separate resource use, capture and concrete mutations.

Use `native/ffi` internally; verify both JIT modes with `test/process/native-bindings.test.ts`.

Expose composition through `./component`; registration remains side-effect free until selection. Declare component dependencies, optional ordering, worker roles and lazy HTTP adapters. Reload and lifecycle contributions preserve instance isolation and failed-start cleanup.

Native release preparation uploads each built PTY target with its verified receipt. Build identity includes builder, native sources and libc target; CI transfers full PTY output and watcher assets.

Use `file/view` for selected Workspace paths and bounded content reads.

Trusted transfers use `workspace-file/service`: imports accept stable operation IDs; `serveFile` accepts byte limits. Streams retain Runtime/resources after request return until read completion, cancellation or Workspace disposal. Run SQLite/PG `managed-transfer.test.ts` and native lifetime verification.

`environment/profiles` owns global profiles and local/S3/OSS factories. Snapshot settings, fail closed, and keep external mounts read-only. Test `test/environment/profiles.test.ts`; `SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE` enables Docker integration.

Session transfer directories use `session/transfer-workspace`; verify `test/session/transfer.test.ts`.

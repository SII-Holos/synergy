# local-runtime Package

Own native execution, reload, CLI host adapters and public exports.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run typecheck, affected tests and root package/dependency checks.

Keep lifecycle in Harness and register local capabilities here. Local Host captures home and environment once; `createLocalClient` requires its Runtime Handle and explicit Scope selector. Worker modules export startup functions and activate only at their selected entrypoint. Session HTTP handlers and in-process clients share `session-api.ts`; preserve Scope ownership, durable inbox scheduling and cancellation. Do not import CLI, HTTP-server or product implementation packages.

- Own bundled model SDK factories and custom SDK loading in `src/provider/sdk-registry.ts`; register them through `registerLocalRuntime()` in host and agent workers.
- Own native/Docker Environment providers, Executor transport and receipts. Reuse `OwnedProcess` and Workspace coordination; release durable claims only after saved output and files. Validate `bun test test/environment test/workspace/coordinator.test.ts` and the Docker integration described in the package README.
- Own native PTY, Linux process ownership, filesystem watchers, OS sandbox backends, helper Rust sources and packaging assets. Published modules resolve native resources through platform optional dependencies. Build the native library with `bun script/build-pty.ts`; validate byte drainage and ownership with `bun test test/process/native-pty.test.ts test/process/pty.test.ts test/process/owned-process-linux.test.ts`. Register `SandboxHost` and the `file-watcher` Scope startup contribution explicitly; keep permission policy and generic wrapper types in harness.
- Linux watcher preparation and release assets use `script/build-watcher.ts` and its pinned source patch. Validate the compiled binding and signal recovery; an unused C++ source edit does not fix the installed watcher.

Workspace removal and automatic reclamation share the lifecycle gate and native retirement claim. Git/setup processes use the Workspace process owner; short metadata mutations must not reserve a read-only turn as a writer. Preserve active users, on-disk lock ownership, and unverified local commits. Validate workspace changes with `bun test test/workspace` plus the Presets worktree suites.

Workspace coordination owns physical overlap and process identity across Runtimes. Launchers bind process claims before activating commands and retain ownership through actual exit. Windows Job Objects, macOS coalitions and Linux subreaper completion receipts supply native liveness; native workers own stream drainage independently; validate both with `bun test test/process/owned-process.test.ts test/workspace/bash-footprint.test.ts` and the Windows-owned process suites on Windows.

Workspace file indexes, native subscriptions and edit evidence follow the resolved Workspace generation. Configuration subscriptions remain Scope-owned. File events carry Workspace identity and the committed content version; test sibling directories with `bun test test/workspace-file/isolation.test.ts`.

Use public `process/owned-process`, `file/mutation`, `file/link` and `file/rename` exports. Preserve byte versions, native link kinds and exclusive publication. Snapshots use Harness link encoding. Acquire resource pins before activation; Sandbox grants never imply writer exclusion. Versioned Executor inputs separate resource use, capture and concrete mutations.

Use `native/ffi` internally; verify both JIT modes with `test/process/native-bindings.test.ts`.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Native release preparation builds and uploads each PTY target with its verified receipt. Build identity includes the PTY builder, native sources and libc target; shared CI preparation transfers the complete PTY output alongside watcher assets.

Use `file/view` for selected Workspace paths and bounded content reads.

Trusted transfer hosts use `workspace-file/service`: managed imports may carry a stable operation ID, and `serveFile` accepts an explicit byte limit. Streams retain their Runtime/resource context across request return and close on read completion, cancellation or Workspace disposal; keep SQLite/PG `managed-transfer.test.ts` and native lifetime verification.

`environment/profiles` owns global profiles and local/S3/OSS factories. Snapshot settings, fail closed, and keep external mounts read-only. Test `test/environment/profiles.test.ts`; `SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE` enables Docker integration.

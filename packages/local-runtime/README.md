# Local runtime

`@ericsanchezok/synergy-local-runtime` composes the harness with local filesystem/process tools, workspace handling, skills, commands and interactive questions. It does not import the HTTP server or desktop product modules.

`openLocalRuntime({ mode: "oneshot" })` registers local capabilities and acquires the harness lifecycle handle. Await `close()` or use `await using` to drain sessions, worker pools, child processes and telemetry before releasing the isolated home. Lifecycle implementation belongs to `@ericsanchezok/synergy-harness/lifecycle`.

`createLocalClient(handle, { scopeID })` (or an explicit directory selector) provides the session, event, permission and question operations used by the CLI. The client enters its supplied Runtime and resolves its Scope for each operation. HTTP routes delegate session creation, input and command submission to the same `session-api` functions; remote CLI calls continue to use the SDK.

Run `bun test test/client.test.ts` for the in-process Scope/event contract and `bun run typecheck`. Tests use the isolated home preload declared in `bunfig.toml`.

Package entrypoint contracts are verified by `bun test test/component.test.ts test/cli/scope.test.ts test/skill/summary.test.ts test/workspace/relocation.test.ts`: selected worker registration, Home reload wiring, CLI Scope cleanup, discovered skill summaries and copied Git metadata independence.

`registerLocalRuntime()` also registers bundled model SDK factories and the custom SDK loader. Agent worker bootstrap creates an explicit Runtime context, registers local capabilities, then starts the harness runner.

Source workers launch this package’s `src/agent-worker.ts` through the harness worker-entry registration. The full product registers its own entry; compiled executables dispatch the same composition through `__agent-turn-runner`.

Native execution belongs here: `process/pty`, `file/watcher`, and the macOS/Linux/Windows sandbox backends and helper sources. `registerLocalRuntime()` registers the sandbox host and the file-watcher startup contribution before commands or workers execute. Build sandbox helpers with `bun script/build-helper.ts`; Linux bwrap development setup uses `bash script/download-bwrap.sh`.

Trusted host workers use `OwnedProcess.prepare({ ownership, ... })` from `process/owned-process`. Its ownership callback receives an immutable native process-tree reference before activation. Persist that reference before returning from `bindProcess`; verify exit in `release` before relinquishing the host claim. `OwnedProcess.inspect` preserves uncertainty after lost supervisors and `terminate` addresses only the recorded tree. Completion receipts remain available during release and are removed afterward. Workspace commands supply their real access lease through the same ownership interface. Validate standalone workers with `bun test test/process/host-worker.test.ts` and Linux tree proof with `test/process/owned-process-linux.test.ts` on Linux.

Explicit JITless execution uses Bun's bundled C compiler to bind the same packaged native libraries; ordinary execution uses Bun's engine FFI. Neither mode requires a separate compiler at execution time. `bun test test/process/native-bindings.test.ts` checks file publication, process ownership and PTY output in both modes.

Local Runtime registers a borrowed native Environment provider without allocating resources. `localRuntime({ environment: false })` omits it for embedded compositions that supply other providers. The native Executor shares process ownership and Workspace coordination with local tools; see [Environments](../../docs/architecture/environments.md). Validate it with `bun test test/environment test/workspace/coordinator.test.ts`.

Hosts opening a `NativeExecutor` directly supply a `WorkspaceCoordinator` from `workspace/coordinator`. Cooperating native executors use the same host claim directory; isolated test runtimes use a private one. Execution input staging and sandbox cleanup stay with this executor through saved completion. Protocol version 2 uses explicit resource pins separately from managed mutation paths and Sandbox policy; update the Execution Host image together with its client.

`registerDockerEnvironment({ endpoint })` registers a managed Docker provider in the composing Runtime. Local Unix sockets and remote TLS Docker Engine endpoints use the same lifecycle. `ExecutionHost.listen` and `RemoteExecutor` expose the same Executor through authenticated Unix sockets or HTTPS. Build the separate execution image with `bun run build:execution-host`; run its real allocation test with `SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE=synergy-execution-host:development bun test test/environment/docker.test.ts`. Pass `--arch x64` or `--arch arm64` to build for a specific Linux target. The image contains a process supervisor, native ownership library, verified file watcher and Linux sandbox helper, without an Agent Runtime or Agent database. The Docker host must support unprivileged user namespaces and nested bubblewrap; incompatible kernel or security-module policies fail contained commands.

`environment/docker` exports `dockerEnvironmentHostConfig()` for a privileged Engine broker to validate the exact confinement policy used by the provider. Hosts validate the image, allocation identity, resource limits and mount selection independently; the helper grants no Engine access.

On Docker hosts with AppArmor enabled, load the supplied `src/environment/vendor/synergy-execution.apparmor` using `sudo apparmor_parser -r <profile-file>` on the daemon host before allocation. Synergy selects its `synergy-execution-v1` profile automatically; a missing profile fails allocation. The policy permits the inner sandbox's mount operations while preserving Docker's other AppArmor restrictions. The runtime does not install host policies or disable AppArmor.

The `workspace/blob-store` export supplies `s3BlobStore` and `ossBlobStore` for Harness `WorkspaceBlobs` registration. Their credential callbacks allow the host to rotate credentials without persisting them in Workspace specs. Classic and anchored file tools select dormant object or active Executor views through the same file facade; file-only object edits allocate no compute. Validate signing, bounded reads, checkpoint materialization and source-loss restoration with `bun test test/workspace/blob-store.test.ts test/workspace/tree.test.ts`.

Coding reads and searches use shared display budgets; anchored edits return compact final-file previews with full UI diffs. See [workspace file architecture](../../docs/architecture/workspace-and-files.md). The fixed-input observation probe at `test/tools/coding-observation-probe.test.ts` can emit versioned UTF-8 byte measurements through `SYNERGY_OBSERVATION_REPORT`; it does not invoke a model or estimate token savings.

Selective hosts call `registerLocalToolInputHistory()` from `./tool-input-history` while composing their tool catalog. This retains owned input migrations without registering native providers or product tool groups.

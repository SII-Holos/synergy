# Local runtime

`@ericsanchezok/synergy-runtime-local` composes the harness with local filesystem/process tools, workspace handling, skills, commands and interactive questions. It does not import the HTTP server or desktop product modules.

`openLocalRuntime({ mode: "oneshot" })` registers local capabilities and acquires the harness lifecycle handle. Await `close()` or use `await using` to drain sessions, worker pools, child processes and telemetry before releasing the isolated home. Lifecycle implementation belongs to `@ericsanchezok/synergy-harness/lifecycle`.

`createLocalClient()` provides the session, event, permission and question operations used by the CLI. Call it within an explicit `ScopeContext.provide()` scope. HTTP routes delegate session creation, input and command submission to the same `session-api` functions; remote CLI calls continue to use the SDK.

Run `bun test test/client.test.ts` for the in-process Scope/event contract and `bun run typecheck`. Tests use the isolated home preload declared in `bunfig.toml`.

`registerLocalRuntime()` also registers bundled model SDK factories and the custom SDK loader. Agent worker bootstrap performs the same registration before starting the harness runner.

Source workers launch this package’s `src/agent-worker.ts` through the harness worker-entry registration. The full product registers its own entry; compiled executables dispatch the same composition through `__agent-turn-runner`.

Native execution belongs here: `process/pty`, `file/watcher`, and the macOS/Linux/Windows sandbox backends and helper sources. `registerLocalRuntime()` registers the sandbox host and the file-watcher startup contribution before commands or workers execute. Build sandbox helpers with `bun script/build-helper.ts`; Linux bwrap development setup uses `bash script/download-bwrap.sh`.

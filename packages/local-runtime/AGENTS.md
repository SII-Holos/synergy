# local-runtime Package

- Own domain tools, routes, config and migrations.
- Own config schemas, normalization, references and secrets in `src/config-schema.ts`; use its typed reader and host-composed registration.
- Import declared public exports; preserve cancellation, permissions and persisted data.
- Tests use test/ and isolated testing-support Homes.
- `Skill.snapshot` reuses canonical parsing/collision rules for host-authorized roots without resetting Scope caches; test `test/skill/snapshot.test.ts`.
- Question owns pending windows and answers; decide/reconcile uses native Session receipts. Restore Scope for deferred settlement and redact private answers. Verify question decision-receipt/pending-window suites.

Typecheck; verify tests and dependencies.

Harness owns lifecycle. Local Host snapshots Home/environment. `createLocalClient` requires Runtime Handle/Scope. Workers use selected entrypoints. HTTP/in-process clients share `session-api.ts`; preserve Scope, Inbox scheduling and cancellation. Never import CLI, server or product implementations.

`resources` owns telemetry-independent sampling. Register `ResourceHost` before startup; verify `test/resources` and both JIT modes.

- Own model SDK factories/loading in `src/provider/sdk-registry.ts`; `registerLocalRuntime()` registers host and worker sources.
- Image decoding uses `AttachmentImageInput`; verify `test/attachment/image-input.test.ts` and Media's attachment suite.
- Own native/Docker providers, Executor transport and receipts. Require Session/Host origins and owned Uses. Retain `OwnedProcess`/Workspace claims through final saving and publication. Verify `bun test test/environment test/workspace/coordinator.test.ts` and README's Docker integration.
- Own PTYs, process maintenance, Linux ownership, watchers, sandboxes, Rust helpers and packaging. Use platform optional dependencies. Build: `bun script/build-pty.ts`; test process/maintenance, native-pty/pty/owned-process-linux. Require origins; drain completion; retain uncertain starts without killing/replaying. Register `SandboxHost` and `file-watcher` Scope startup; Harness owns policy/wrappers.
- Linux watcher assets use `script/build-watcher.ts` and its pinned source patch. Validate the compiled binding and signal recovery; an unused C++ source edit does not fix the installed watcher.

Workspace removal and reclamation share the lifecycle gate and native retirement claim. Git/setup commands use the Workspace process owner; short metadata mutations cannot reserve read-only turns as writers. Preserve active users, on-disk locks and unverified commits. Run `bun test test/workspace` and Presets worktree suites.

Cooperating Runtimes coordinate physical overlap/process identity. Bind before commands; retain through saving. Tokens prove release; exclusive recovery requires unchanged roots; `workspace/cleanup` only releases. Move/adoption claims guard publication; release outside SQL. Never undo published data. Verify `test/process/owned-process.test.ts`, `test/workspace/{move,access-maintenance,bash-footprint}.test.ts` and Windows suites.

Workspace file indexes, native subscriptions and edit evidence follow the resolved Workspace generation. Configuration subscriptions are Scope-owned. File events carry Workspace identity and the committed content version; test sibling directories with `bun test test/workspace-file/isolation.test.ts`.

Use public `process/owned-process`, `file/mutation`, `file/link` and `file/rename` exports. Preserve byte versions, native link kinds and exclusive publication. Snapshots use Harness link encoding. Acquire resource pins before activation; Sandbox grants never imply writer exclusion. Versioned Executor inputs separate resource use, capture and concrete mutations.

Use `native/ffi` and descriptor-relative `file/atomic-write`; preflight retirement. Verify `test/{process/native-bindings,file/atomic-write}.test.ts` with/without JIT.

Expose composition through `./component`; registration remains side-effect free until selection. Declare component dependencies, optional ordering, worker roles and lazy HTTP adapters. Reload and lifecycle contributions preserve instance isolation and failed-start cleanup.

Native release preparation uploads each built PTY target with its verified receipt. Build identity includes builder, native sources and libc target; CI transfers full PTY output and watcher assets.

Use `file/view`; Formatter advances observations. SessionReadSource gates native Session history before lookup.

Trusted transfers use `workspace-file/service`: imports accept stable operation IDs; `serveFile` accepts byte limits. Streams retain Runtime/resources after request return until read completion, cancellation or Workspace disposal. Run SQLite/PG `managed-transfer.test.ts` and native lifetime verification.

`environment/profiles` owns global profiles and local/S3/OSS factories. Snapshot settings, fail closed, and keep external mounts read-only. Test `test/environment/profiles.test.ts`; `SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE` enables Docker integration.

Explicit `environment: "native"` selects the native provider/default without personal profiles. Hosted compositions supply providers. Descriptor portability requires explicit composition; verify `test/session-transfer-environment*.test.ts`.

Transfers: `session-transfer-workspaces`, `session-transfer-workspace-target`, `workspace/{native-adoption,native-download,cleanup,portable-target}`; trees: `workspace/{file-host,portable-tree,portable-git,portable-target}`; claims: `session-transfer-physical`. Paged checkpoints/imports preserve identity/policy. Verify source/target/physical/session-workspaces-transfer/native-download, file-host-paged, mount-paged, tree/Git.

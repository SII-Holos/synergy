# harness

This package owns Synergy's generic execution runtime. Application hosts use the [public entry points](../../docs/architecture/README.md#harness-public-entry-points); individual host contracts are declared explicitly in `package.json`. Test-only exports are excluded from published packages.

Run `bun run typecheck`, `bun run test`, and `bun run build` from this package.

Model SDK implementations belong to `local-runtime`. Research hosts register `ProviderSdkSource` with synchronous and asynchronous factory loaders; SDK access before registration fails explicitly. The `ai` engine remains a harness dependency and itself includes the Gateway adapter transitively.

Custom SDK factories belong to each Runtime instance. Research hosts using agent workers register a bootstrap entry with `registerAgentWorkerEntrypoint()` that creates its explicit Runtime context and installs the same SDK source before starting the harness runner; in-process experiments register their source in the current process.

The harness owns permission policy and the `SandboxHost` execution contract. OS sandbox implementations, native PTYs and filesystem watchers belong to `local-runtime`. Sandboxed tool execution without a registered host fails explicitly; a bare research harness starts no native file watcher.

Embedded tool admission uses `tool/policy-source`: a host can narrow visible and deferred identities and authorize exact calls before execution resources are acquired. The source cannot widen the registry or replace permission and sandbox decisions. The public `cortex/tools` entry exposes the complete suite for explicit registration.

The `environment` host entries own durable allocation and operation identities. Register providers before opening a Runtime; missing providers fail explicitly. See [Environments](../../docs/architecture/environments.md) for execution, checkpoint and recovery semantics.

Hosts supply immutable environment and paths, composition, and storage ownership to `RuntimeHandle.open()`. Imports have no registration side effects. Enter work with `handle.run()` or capture callbacks with `handle.bind()`; await `close()` or use `await using`. Multiple handles can coexist in one process. See [Runtime and Scope](../../docs/architecture/runtime-and-scope.md) for lifecycle and workspace semantics.

The public `/usage` entry exposes retained accounting, typed queries, clear/rebuild operations, and explicit host lifecycle/transfer integration. Its [accounting contract](../../docs/architecture/usage-accounting.md) is independent of transcript and archive retention.

Selective tool catalogs use `cortexTools()` and register `registerCortexToolInputHistory()` from `./cortex/tools` before sealing the Runtime. The history registration keeps owned session migrations independent of product tool registration.

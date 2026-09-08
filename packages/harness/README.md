# harness

This package owns Synergy's generic execution runtime. Application hosts use the eight [public entry points](../../docs/architecture/README.md#harness-public-entry-points); individual host contracts are declared explicitly in `package.json`. Test-only exports are excluded from published packages.

Run `bun run typecheck`, `bun run test`, and `bun run build` from this package.

Model SDK implementations belong to `runtime-local`. Research hosts register `ProviderSdkSource` with synchronous and asynchronous factory loaders; SDK access before registration fails explicitly. The `ai` engine remains a harness dependency and itself includes the Gateway adapter transitively.

Custom SDK factories are process-local. Research hosts using agent workers register a bootstrap entry with `registerAgentWorkerEntrypoint()` that installs the same SDK source before importing the harness runner; in-process experiments register their source in the current process.

The harness owns permission policy and the `SandboxHost` execution contract. OS sandbox implementations, native PTYs and filesystem watchers belong to `runtime-local`. Sandboxed tool execution without a registered host fails explicitly; a bare research harness starts no native file watcher.

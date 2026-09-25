# plugin-host Package

Plugin processes, discovery, configuration, trust, permissions and capability-gated Host Services. Use the public plugin author contracts. Host Services expose actually registered capabilities; avoid importing every product domain from the host. Read the root AGENTS.md and the owning architecture document before changes.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Own configuration schemas, normalization, reference checks and secret handling in `src/config-schema.ts`; consumers use its typed reader and the host composes its registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Tests live under test/ and use isolated homes through the testing support package.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

File-capable invocations pin canonical Workspace generations. Restore the invocation async context for every IPC Host callback, drain Host work before releasing ownership, and preserve native file conflicts. Verify with `bun test test/plugin-runtime/workspace-context.test.ts test/plugin/tool-invocation.test.ts test/plugin/shell-host-service.test.ts`.

Expose composition through `./component`; keep registration side-effect free until the factory is selected. Declare required components, optional ordering, worker roles and lazy HTTP adapters explicitly. Runtime-scoped reload and lifecycle contributions must preserve isolated instances and failed-start cleanup.

Own the installation generation ledger under `src/installation`. Its pre-bootstrap metadata, integrity verification and recovery must remain independent of Harness imports. Component activation and existing API4 plugin transactions share the same cross-process installation lock; retain old generations while processes may still use their modules. Host-code trust does not grant API4 plugin capabilities.

Add/update/remove preserves explicit roots and the package-manager lock; rebuild a stage from that lock to prune removed dependencies. Resolve the selected graph to one canonical Harness before importing component factories, compare executable declarations with approved metadata, and pin worker generations by their manifest digest.

The dependency-light `installation/catalog` leaf owns the four first-party install selections and aliases. Source Presets, the installer and release tooling consume it without a core dependency on complete-product assembly.

# harness Package

Own the harness implementation, Runtime component/lifecycle contracts and public exports. Follow root rules and the owning architecture document.

- Keep domain tools, routes, configuration and migrations with their implementation.
- Keep optional product schemas out of the harness. `SessionSchemaRegistry` composes owner session fields, creation/import behavior and indexes; workflow state and execution/recovery policy belong to their domain packages. `ConfigExtensions` composes owner contracts; unregistered fields remain on disk and stay out of client output. Full product composition explicitly completes schema registration.
- Import other packages only through declared public exports; preserve cancellation, permissions and persisted data.
- Supply Host, composition and owned or borrowed storage to `RuntimeHandle`. Registration is sealed for that instance before storage startup; imports cannot register capabilities. Use `run` for owned work and `bind` for native callbacks. Migration listings are detached snapshots. Test independent instances in one process and entrypoint behavior in isolated child processes.
- Tests live under test/ and use explicit Runtime fixtures with isolated homes. Pure functions need no Runtime; migration mechanism tests use the explicit unsealed migration fixture.

Run bun run typecheck and the affected tests, then the root package and dependency checks.

- Keep concrete model SDK factories out of harness; hosts register `ProviderSdkSource`. An absent source must fail explicitly without installing SDKs.
- Keep native PTYs, filesystem watchers and OS sandbox implementations in local-runtime. Harness owns permission policy and `SandboxHost`; missing host registration must fail closed for sandboxed execution.

- Keep application-facing operations under the explicit session, scope, tools, context, lifecycle, config, persistence and rollout entries. Host adapters may use individually declared contract leaves; never export processor, resolver, scheduler or journal implementations to production. Published manifests omit `test/` exports, and production sources must not import them. Within this package use relative owner imports, not public entry points.
- File browsing, indexing, Ripgrep, Hashline editing and conflict resolution belong to local-runtime; this package retains execution read evidence and locking.
- Native file imports cross the Runtime-scoped `workspace/file-import` Host contract; register the implementation before opening the Runtime and reject unavailable hosts explicitly.
- Workspace catalog references and binding generations own file identity. Native write admission uses `workspace/access`; execution-capacity scheduling remains private. File resources use `WorkspaceState`; Scope configuration and event sequencing use `ScopedState`. Startup contributions declare Workspace ownership when they depend on working files.
- Metadata mutations have short claims. Retirement admits only its owner. Session selection pins destinations and drains registered resources before commit; file-aware commands share the binding lease. Release claims when capacity resumption fails.

Agent authority is owned by `Storage.Handle`: read [Agent storage](../../docs/architecture/agent-storage.md) before persistence changes. Use SQL business transactions for records, indexes and outbox entries; keep files and external effects outside retryable callbacks. The central bootstrap owns historical JSON import and activation. Runtime and maintenance entry points run registered owner recovery before admission. Storage engine changes run `bun test test/storage`; macOS packaging changes also run `bun test --config /dev/null test/script/release/workspace-sqlite.test.ts` from the repository root; the PostgreSQL CI matrix requires a real database via `SYNERGY_TEST_POSTGRES_URL`.

Secret capture keeps Vault and execution-time resolution here; detector contracts and regex evaluation belong to `packages/secret-detection`. Register replacement detectors through `secrets/detector-source` before runtime startup. Run `bun test test/secrets/` and `bun run benchmark:secrets` for capture changes; the benchmark owns a disposable home.

Storage transfer callers use the public `storage/compat` convergence guard before copying deferred datasets. The central migration runner stages records for shared migrations and tracks owner-local cohorts; background import remains owned and drained by the Runtime Handle.

File-change evidence belongs to admitted Workspace write operations. Preserve qualified before/after pairs and capture failures across history and transfer. Verify snapshot, summary, history and Local Runtime's `test/workspace/change-attribution.test.ts`.

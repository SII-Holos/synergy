# harness Package

Own lifecycle, features, exports, `./host/identity`. `context` owns pure attribution; `agent/primary-identity` maps primary names. Pairing: [Host connections](../../docs/architecture/host-connections.md).

- Keep domain tools, routes, configuration and migrations with their implementation.
- `SessionExecutionOwners` gates execution against components using references and `MessageV2` semantics. Preserve blocked records; human tasks cannot resume unavailable predecessors. Persist independent root admission and Agent selection; separate execution views from canonical Session writes. Compose receipts through native owners. Observe activity and release evidence without recovery; verify `test/session/{resume,rollout-cancel,rollout-activity}.test.ts`.
- Session L/progress: `session/long-term-memory`, never workflows/Library. [State](../../docs/architecture/session-and-messages.md#session-long-term-summary).
- `SessionSchemaRegistry` composes owner fields, inheritance, transactional validation and indexes; domains own workflow state and execution/recovery policy. `ConfigExtensions` composes owner contracts; unregistered fields remain on disk but outside client output. Full composition explicitly completes schema registration.
- Use public package exports; preserve cancellation, permissions and persisted data.
- `RuntimeHandle` owns Host, composition and storage; seal registration before startup. Use `run` for work, `bind` for native callbacks. Persisted Home ownership must match. Node provisioning reuses `HomeOwnershipFile`. Test isolated instances and child entrypoints; keep migration listings detached.
- Use unsealed fixtures for migration mechanism tests.

- Hosts select `ProviderSdkSource`, `AttachmentImageInput`, `InstructionSource` and `ConfigSource`. `ProjectConfig` reads allowed project fields. Verify absence and `test/attachment/model-input.test.ts`.
- Instruction consumers forward Session IDs for per-Session catalogs; omitted IDs preserve personal behavior. Domains own provenance/authorization.
- Local Runtime owns native PTYs, watchers and OS sandboxes. `workspace/observation` qualifies invalidations; Session owns live comparisons. Harness owns permission policy and `SandboxHost`; missing host registration must fail closed for sandboxed execution.

- Expose public domain operations; `session/prompt-budgeter` measures native model messages. Host adapters may use declared contract leaves; never export processor, resolver, scheduler or journal implementations to production. Published manifests omit `test/` exports. Use relative imports internally.
- File browsing, indexing, Ripgrep, Hashline editing and conflict resolution belong to local-runtime; this package retains execution read evidence and locking.
- Native file imports cross the Runtime-scoped `workspace/file-import` Host contract; register the implementation before opening the Runtime and reject unavailable hosts explicitly.
- Harness owns [resource admission](../../docs/architecture/resource-admission.md); Local Runtime supplies samples. Verify `test/resources/`.
- Workspace catalog references and binding generations own file identity. Native write admission uses `workspace/access`; execution-capacity scheduling remains private. File resources use `WorkspaceState`; Scope configuration and event sequencing use `ScopedState`. Startup contributions declare Workspace ownership when they depend on working files.
- Tool `resourceNeeds` augments static requirements through the resolver. Follow `add-tool`.
- Environment ownership: [Environments](../../docs/architecture/environments.md).
- Metadata mutations have short claims. Retirement admits only its owner. Session selection pins destinations and drains registered resources before commit; file-aware commands share the binding lease. Release claims when capacity resumption fails.

`Storage.Handle` owns Agent authority; read [Agent storage](../../docs/architecture/agent-storage.md) before persistence changes. Use SQL transactions for records, indexes and outbox entries; keep files and external effects outside retryable callbacks. Central bootstrap owns historical JSON import and activation. Runtime and maintenance entry points recover registered owners before admission. Storage engine changes run `bun test test/storage`; macOS packaging changes run root `bun test --config /dev/null test/script/release/workspace-sqlite.test.ts`; PostgreSQL CI requires a real database via `SYNERGY_TEST_POSTGRES_URL`.

Register PG contracts in `test/support/storage-backends.ts`; see [backend selection](../../.synergy/skill/testing-guide/SKILL.md).

Vault and execution-time secret resolution stay here; detection belongs to `packages/secret-detection`. Derived batches use `SecretMask.captureAndApplyMany`/`revision()`. Register replacement detectors through `secrets/detector-source` before runtime startup. Run `bun test test/secrets/` and `bun run benchmark:secrets` for capture changes; the benchmark owns a disposable home.

Storage transfer callers use the public `storage/compat` convergence guard before copying deferred datasets. Central migrations stage shared records and track owner cohorts; Runtime Handle drains background imports.

Session summaries compare Workspace checkpoints across all writers. Keep tool evidence separate. File restoration requires version-checked previews. Verify snapshots, summaries, history and Local Runtime's `test/workspace/change-attribution.test.ts`.

Paused transfer: `session/transfer`, `session/transfer-workspace`; verify `test/session/transfer.test.ts`.

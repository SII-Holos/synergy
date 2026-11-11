# harness Package

Own lifecycle, features and `./host/identity`; `context` owns attribution and `agent/primary-identity` primary names. See: [Host connections](../../docs/architecture/host-connections.md).

- Keep tools, routes, config and migrations with their domain.
- `SessionExecutionOwners` gates components using references and `MessageV2` semantics. Preserve blocked records; human tasks cannot resume unavailable predecessors. Root admission and Agent selection persist independently; execution views cannot replace Session writes. Compose native receipts and observe activity/release without recovery; verify `test/session/{resume,rollout-cancel,rollout-activity}.test.ts`.
- Session L/progress: `session/long-term-memory`, never workflows/Library. [State](../../docs/architecture/session-and-messages.md#session-long-term-summary).
- `SessionSchemaRegistry` composes owner fields, inheritance, validation/indexes and epoch-only adoption; domains own workflow state and execution/recovery policy. `ConfigExtensions` composes owner contracts; unregistered fields remain on disk but outside client output. Full composition explicitly completes schema registration.
- `RuntimeHandle` owns Host, composition and storage; seal registration before startup. Use `run` for work, `bind` for native callbacks. Persisted Home ownership must match. Node provisioning reuses `HomeOwnershipFile`. Test isolated instances and child entrypoints; keep migration listings detached.
- Use unsealed migration fixtures.

- Hosts select `ProviderSdkSource`, `AttachmentImageInput`, `InstructionSource` and `ConfigSource`. `ProjectConfig` reads allowed project fields. Verify absence and `test/attachment/model-input.test.ts`.
- Instruction consumers forward Session IDs for per-Session catalogs; omitted IDs preserve personal behavior. Domains own provenance/authorization.
- Local Runtime owns native PTYs, watchers and OS sandboxes. `workspace/observation` qualifies invalidations; Session owns live comparisons. Harness owns permission policy and `SandboxHost`; missing host registration must fail closed for sandboxed execution.

- Expose public domain operations; `session/prompt-budgeter` measures native model messages. Host adapters may use declared contract leaves; never export processor, resolver, scheduler or journal implementations to production. Published manifests omit `test/` exports. Use relative imports internally.
- Local Runtime owns browsing, indexing, search, editing and conflicts; Harness retains execution read evidence and locking.
- Native file imports cross the Runtime-scoped `workspace/file-import` Host contract; register the implementation before opening the Runtime and reject unavailable hosts explicitly.
- Harness owns [resource admission](../../docs/architecture/resource-admission.md); Local Runtime supplies samples. Verify `test/resources/`.
- Workspace catalog references and binding generations own file identity. Native write admission uses `workspace/access`; execution-capacity scheduling remains private. File resources use `WorkspaceState`; Scope configuration and event sequencing use `ScopedState`. Startup contributions declare Workspace ownership when they depend on working files.
- Tool `resourceNeeds` augments static requirements through the resolver. Follow `add-tool`.
- Environment ownership: [Environments](../../docs/architecture/environments.md).
- Metadata mutations have short claims. Retirement admits only its owner. Session selection pins destinations and drains registered resources before commit; file-aware commands share the binding lease. Release claims when capacity resumption fails.

`Storage.Handle` owns [Agent authority](../../docs/architecture/agent-storage.md), transactions and content lifetimes. External effects precede references. Pin checkpoint locations; verify complete logical scans against captured manifests. Fence restores. Archives require Host authority; history cannot authorize. Read object v1/v2. Maintenance requires native drainage; preserve purpose/cohort holds. Test storage/secrets locally. SQLite packaging: root workspace-sqlite tests; PG: `SYNERGY_TEST_POSTGRES_URL`.

Register PG contracts in `test/support/storage-backends.ts`; see [backend selection](../../.synergy/skill/testing-guide/SKILL.md).

Vault and execution-time secret resolution stay here; detection belongs to `packages/secret-detection`. Derived batches use `SecretMask.captureAndApplyMany`/`revision()`. Register replacement detectors through `secrets/detector-source` before runtime startup. Run `bun test test/secrets/` and `bun run benchmark:secrets` for capture changes; the benchmark owns a disposable home.

Before copying deferred datasets, use `storage/compat` convergence. Central migrations stage shared records and owner cohorts; Runtime Handle drains imports.

Session summaries compare checkpoints across Workspace writers. Separate tool evidence. Restore through version-checked previews. Use versioned Snapshot ownership and opaque capture. Verify snapshots, summaries, history and Local Runtime's `test/workspace/change-attribution.test.ts`.

Cortex holds retain task/root/input/budget/deadline/notification identity, never cancel/recreate or auto-resume. Personal transfer: `session/transfer`, `session/transfer-workspace`; verify `test/session/transfer.test.ts`.

Aggregate portability: drained source cohorts, epochs/streams, private Snapshot staging, declared dependencies, permanent surrender/retirement, prepared tokens/pack pins. Verify `test/session/transfer-*.test.ts`; `test/storage/{artifact-stream,storage-binary-stream,object-artifacts}.test.ts`.

`SessionHistory`: bodyless; iterate children, page Cortex (`test/session/cortex-index.test.ts`).

Install Assets before activation; test `test/asset/portable.test.ts`. Use decision receipts and Scope-qualified pending windows; verify permission suites.

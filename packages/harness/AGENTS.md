# harness Package

Own lifecycle, features and `./host/identity`; `context` owns attribution and `agent/primary-identity` primary names. See: [Host connections](../../docs/architecture/host-connections.md).

- `SessionExecutionOwners` gates components using references and `MessageV2` semantics. Preserve blocked records; human tasks cannot resume unavailable predecessors. Root admission and Agent selection persist independently; execution views cannot replace Session writes. Compose native receipts and observe activity/release without recovery; verify `test/session/{resume,rollout-cancel,rollout-activity}.test.ts`.
- Session L/progress: `session/long-term-memory`, never workflows/Library. [State](../../docs/architecture/session-and-messages.md#session-long-term-summary).
- `SessionSchemaRegistry` owns fields, inheritance, indexes, required portability readers, epoch-only adoption and notification references. Capture original Info synchronously without bodies; verify `test/session/notification-source.test.ts`. Domains own execution/recovery policy. `ConfigExtensions` composes contracts before sealing. Unregistered fields persist outside client output.
- `RuntimeHandle` owns Host/composition/storage; seal registration before startup. Use `run`/`bind` for native work. `HomeOwnershipFile` fences provisioning/recovery/retirement; `lifecycle/namespace-identity` binds primary-namespace evidence. `lifecycle/home-restoration` owns native intents, callback permits and owner evidence. Verify `test/lifecycle/{namespace-identity,home-restoration,home-retirement-file}.test.ts`; isolate tests and detached migrations.
- Use unsealed migration fixtures.

- Hosts select `ProviderSdkSource`, `AttachmentImageInput`, `InstructionSource` and `ConfigSource`. `ProjectConfig` reads allowed project fields. Verify absence and `test/attachment/model-input.test.ts`.
- Instruction consumers forward Session IDs for per-Session catalogs; omitted IDs preserve personal behavior. Domains own provenance/authorization.
- Local Runtime owns native PTYs, watchers and OS sandboxes. `workspace/observation` qualifies invalidations; Session owns live comparisons. Harness owns permission policy and `SandboxHost`; missing host registration must fail closed for sandboxed execution.

- Expose public domain operations; `session/prompt-budgeter` measures native model messages. Host adapters may use declared contract leaves; never export processor, resolver, scheduler or journal implementations to production. Published manifests omit `test/` exports. Use relative imports internally.
- Local Runtime owns browsing, indexing, search, editing and conflicts; Harness retains execution read evidence and locking.
- Native file imports cross the Runtime-scoped `workspace/file-import` Host contract; register the implementation before opening the Runtime and reject unavailable hosts explicitly.
- Harness owns [resource admission](../../docs/architecture/resource-admission.md); Local Runtime supplies samples. Verify `test/resources/`.
- Workspace catalog/binding generations own files. `workspace/access` owns claims, Session admission, callbacks and maintenance drainage; capacity scheduling stays private. File resources use `WorkspaceState`; Scope configuration/events use `ScopedState`. Startup contributions declare ownership. Verify `test/workspace/access-maintenance.test.ts`.
- Tool `resourceNeeds` augments static requirements through the resolver. Follow `add-tool`.
- Drain Environment origins/Uses before freeze. See [Environments](../../docs/architecture/environments.md); verify `test/environment/{execution-origin,origin,use-ownership,transfer-records,execution-portable}.test.ts` and Local `test/session-transfer-environments-native.test.ts`.
- Metadata mutations have short claims. Retirement admits only its owner. Session selection pins destinations and drains registered resources before commit; file-aware commands share the binding lease. Release claims when capacity resumption fails.

`Storage.Handle` owns [Agent authority](../../docs/architecture/agent-storage.md), transactions and content lifetimes. Prepare effects before references; drain binary producers before closure. Pin checkpoints; verify complete logical scans against captured manifests. `assertWriteTransaction` fences callbacks. Archives require Host authority; history cannot authorize. Read object v1/v2. Maintenance drains native/detached writers; reopen admission after confirmed release. Preserve purpose/cohort holds. Test storage/secrets/authority-journal/runtime-maintenance-adoption/maintenance-retirement-records. SQLite: workspace-sqlite; PG: `SYNERGY_TEST_POSTGRES_URL`.

Register PG contracts in `test/support/storage-backends.ts`; see [backend selection](../../.synergy/skill/testing-guide/SKILL.md).

Vault and execution-time secret resolution stay here; detection belongs to `packages/secret-detection`. Derived batches use `SecretMask.captureAndApplyMany`/`revision()`. Register replacement detectors through `secrets/detector-source` before runtime startup. Run `bun test test/secrets/` and `bun run benchmark:secrets` for capture changes; the benchmark owns a disposable home.

Before copying deferred datasets, use `storage/compat` convergence. Central migrations stage shared records and owner cohorts; Runtime Handle drains imports.

Compare Workspace checkpoints; separate evidence. Preserve Snapshot ownership, callback-bound `withTree` references and Archive verification. `WorkspaceContent` writes paged heads; publish preparations inside original receipt transactions. Preserve uncertain preparations. Verify `test/snapshot/`, `test/workspace/{content-producer,portable-tree,archive,archive-paged,tree-import}.test.ts` and Local Runtime's `test/workspace/change-attribution.test.ts`.

Cortex holds preserve task/root/input/budget/deadline/notification identity; never cancel/recreate or auto-resume. Transfer: `session/transfer`, `session/transfer-workspace`; verify `test/session/transfer.test.ts`, `test/cortex/{parent-abort,task-tool-abort}.test.ts`.

Portability: atomic cohorts/epochs, ordered publication, declared dependencies, permanent surrender/retirement, prepared pins, `session-workspaces`. Require Environment owners. Verify `test/session/{transfer-*,workspace-*}.test.ts` and `test/storage/{artifact-stream,storage-binary-stream,object-artifacts}.test.ts`.

`SessionHistory`: indexed headers/fields/attachments; page children/Cortex (`test/session/{part-field-header,attachment-content,attachment-index,cortex-index}.test.ts`).

Install Assets before activation; test `test/asset/portable.test.ts`. Use decision receipts and Scope-qualified pending windows; verify permission suites.

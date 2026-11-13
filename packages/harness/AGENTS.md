# harness Package

Own lifecycle, features and `./host/identity`; `context` owns attribution and `agent/primary-identity` primary names. See: [Host connections](../../docs/architecture/host-connections.md).

- `SessionExecutionOwners` gates components using references and `MessageV2` semantics. Preserve blocked records; human tasks cannot resume unavailable predecessors. Root admission and Agent selection persist independently; execution views cannot replace Session writes. Compose native receipts and observe activity/release without recovery; verify `test/session/{resume,rollout-cancel,rollout-activity,rollout-pending,agent-worker-pool}.test.ts`.
- Session L/progress: `session/long-term-memory`, never workflows/Library. [State](../../docs/architecture/session-and-messages.md#session-long-term-summary).
- `SessionSchemaRegistry` owns fields, inheritance, indexes, required portability readers, epoch-only adoption and notification references. Capture original Info synchronously without bodies; verify `test/session/notification-source.test.ts`. Domains own execution/recovery policy. `ConfigExtensions` composes contracts before sealing. Unregistered fields persist outside client output.
- `RuntimeHandle` owns Host/composition/storage; seal registration before startup. Use `run`/`bind` for native work. `HomeOwnershipFile` fences provisioning/readers/recovery/retirement; `lifecycle/namespace-identity` binds primary-namespace evidence. `lifecycle/home-restoration` owns permits; its Node-safe leaf grants no authority. Verify `test/lifecycle/{namespace-identity,namespace-retirement,home-restoration,home-retirement-file,home-reader-advance}.test.ts`; isolate tests and detached migrations.
- Unsealed fixtures; settle Rollouts last. `Core.storedInfo`/`Source.retainedReceipt`: read-only.

- Hosts select `ProviderSdkSource`, `AttachmentImageInput`, `InstructionSource` and `ConfigSource`. `ProjectConfig` reads allowed project fields. Verify absence and `test/attachment/model-input.test.ts`.
- Instruction consumers forward Session IDs; omission preserves personal catalogs. SessionReadSource precedes native history. Domains own provenance/authorization.
- Local Runtime owns native PTYs, watchers and OS sandboxes. `workspace/observation` qualifies invalidations; Session owns live comparisons. Harness owns permission policy and `SandboxHost`; missing host registration must fail closed for sandboxed execution.

- Expose public domain operations; `session/prompt-budgeter` measures native model messages. Host adapters may use declared contract leaves; never export processor, resolver, scheduler or journal implementations to production. Published manifests omit `test/` exports. Use relative imports internally.
- Local Runtime owns browsing and edits; Harness owns file-source leases, operation receipts, evidence and locking.
- Native file imports cross the Runtime-scoped `workspace/file-import` Host contract; register the implementation before opening the Runtime and reject unavailable hosts explicitly.
- Harness owns [resource admission](../../docs/architecture/resource-admission.md); Local Runtime supplies samples. Verify `test/resources/`.
- Workspace catalog/binding generations own files. `workspace/access` owns claims, Session admission, callbacks and maintenance drainage; capacity scheduling stays private. File resources use `WorkspaceState`; Scope configuration/events use `ScopedState`. Startup contributions declare ownership. Verify `test/workspace/access-maintenance.test.ts`.
- Tool `resourceNeeds` augments static requirements through the resolver. Follow `add-tool`.
- Drain Environment origins/Uses/sources before freeze. See [Environments](../../docs/architecture/environments.md); verify `test/environment/{execution-origin,origin,use-ownership,transfer-records,execution-portable,execution-source-records}.test.ts` and Local `test/session-transfer-environments-native.test.ts`.
- Metadata mutations have short claims. Retirement admits only its owner. Session selection pins destinations and drains registered resources before commit; file-aware commands share the binding lease. Release claims when capacity resumption fails.

`Storage.Handle` owns [Agent authority](../../docs/architecture/agent-storage.md), transactions and content lifetimes. Prepare binaries outside SQL/checkpoints; owners publish. `withRestorationArtifacts` stages recovery bytes; verify `test/storage/restoration-artifacts.test.ts`. Drain writers/producers before closure; reopen after release. Preserve purpose/cohort holds; Home upgrades require native witnesses. Checkpoints and `assertWriteTransaction` fence callbacks. Archives require Host authority; history cannot authorize. Read object v1/v2. Test storage/secrets/authority-{journal,adoption}/runtime-maintenance-{adoption,home-upgrade,source-preparation}/{maintenance-retirement-records,checkpoint-retention}; Organization: `test/backup/pending-retirement.test.ts`. SQLite: workspace-sqlite; PG: `SYNERGY_TEST_POSTGRES_URL`.

Register PG contracts in `test/support/storage-backends.ts`; see [backend selection](../../.synergy/skill/testing-guide/SKILL.md).

Vault and execution-time secret resolution stay here; detection belongs to `packages/secret-detection`. Derived batches use `SecretMask.captureAndApplyMany`/`revision()`. Register replacement detectors through `secrets/detector-source` before runtime startup. Run `bun test test/secrets/` and `bun run benchmark:secrets` for capture changes; the benchmark owns a disposable home.

Check `storage/compat` before copies. Existing-only attachment validates without initialization; test `storage/existing-attach`. Central migrations own upgrades; Runtime Handle drains imports.

Preserve Snapshot ownership, `withPublishedNative`, callback-bound readers, Archive verification/paging and preparations. Atomic heads/receipts. `WorkspaceMove` guards range/adoption claims through COMMIT and unknown outcomes; release outside SQL. Verify `test/snapshot/`, `test/workspace/{content-producer,portable-tree,archive,archive-paged,tree-import}.test.ts` and Local Runtime's `test/workspace/{move,native-adoption,change-attribution}.test.ts`.

Cortex holds preserve task/root/input/budget/deadline/notification identity; never cancel/recreate or auto-resume. Transfer: `session/transfer`, `session/transfer-workspace`; verify `test/session/transfer.test.ts`, `test/cortex/{parent-abort,task-tool-abort}.test.ts`.

Portability: atomic cohorts/epochs, ordered publication, declared dependencies, permanent surrender/retirement, prepared pins, `session-workspaces`. Require Environment owners. Verify `test/session/{transfer-*,workspace-*}.test.ts` and `test/storage/{artifact-stream,storage-binary-stream,object-artifacts}.test.ts`.

`SessionHistory`: indexed headers/fields/attachments; page children/Cortex (`test/session/{part-field-header,attachment-content,attachment-index,cortex-index}.test.ts`).

Install Assets before activation; test `test/asset/portable.test.ts`. Use decision receipts and Scope-qualified pending windows; verify permission suites.

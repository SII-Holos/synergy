# harness Package

Own lifecycle/features/`./host/identity`; `context` owns attribution, `agent/primary-identity` primary names. See [Host connections](../../docs/architecture/host-connections.md).

- `SessionExecutionOwners` gates components through references/`MessageV2`. Preserve blocked records; human tasks cannot resume unavailable predecessors. Persist Root admission/Agent selection independently; views never replace Session writes. Compose native receipts; observe activity/release without recovery. Verify `test/session/{resume,rollout-cancel,rollout-activity,rollout-pending,agent-worker-pool}.test.ts`.
- Session L/progress: `session/long-term-memory`, never workflows/Library. [State](../../docs/architecture/session-and-messages.md#session-long-term-summary).
- `SessionSchemaRegistry` owns fields/inheritance/indexes/portability readers/epoch-only adoption/notification references. Capture original Info synchronously, without bodies; verify `test/session/notification-source.test.ts`. Domains own execution/recovery policy. `ConfigExtensions` composes before sealing; unregistered fields persist outside client output.
- `RuntimeHandle` owns Host/composition/storage; seal before startup. Native work uses `run`/`bind`. `HomeOwnershipFile` fences provisioning/readers/recovery/retirement; `lifecycle/namespace-identity` binds primary evidence. `lifecycle/home-restoration` owns permits; its Node-safe leaf grants no authority. Verify `test/lifecycle/{namespace-identity,namespace-retirement,home-restoration,home-retirement-file,home-reader-advance}.test.ts`; isolate tests/detached migrations.
- Unsealed fixtures; settle Rollouts last. `Core.storedInfo`/`Source.retainedReceipt`: read-only.

- Hosts select `ProviderSdkSource`/`AttachmentImageInput`/`InstructionSource`/`ConfigSource`; `ProjectConfig` reads allowlisted project fields. Verify absence and `test/attachment/model-input.test.ts`.
- Instruction consumers forward Session IDs; omission preserves personal catalogs. SessionReadSource/ProcessAccessSource gate history/process access; domains own provenance/authorization.
- Local Runtime owns native PTYs/watchers/OS sandboxes. `workspace/observation` qualifies invalidations; Session owns live comparisons. Harness owns permissions/`SandboxHost`; sandboxed execution fails closed without host registration.

- Expose public domain operations; `session/prompt-budgeter` measures native messages. Host adapters use declared leaves; never export processor/resolver/scheduler/journal implementations to production. Published manifests omit `test/` exports; internal imports stay relative.
- Local Runtime owns browsing/edits; Harness owns file-source leases/receipts/evidence/locking. Remote Session bindings require actual Catalog/synchronous registered file-owner inspection; metadata never authorizes effects. Keep checkpoint journals private behind WorkspaceOperations publication inspection.
- Native imports use Runtime-scoped `workspace/file-import` Host contracts; register implementations before Runtime opening, explicitly reject unavailable hosts.
- Harness owns [resource admission](../../docs/architecture/resource-admission.md); Local Runtime supplies samples. Verify `test/resources/`.
- Workspace catalog/binding generations own files. `workspace/access` owns claims/Session admission/callbacks/maintenance drainage; capacity scheduling stays private. File resources use `WorkspaceState`; Scope configuration/events use `ScopedState`. Startup contributions declare ownership. Verify `test/workspace/access-maintenance.test.ts`.
- Tool `resourceNeeds` augments static requirements via resolver. Follow `add-tool`.
- Drain Environment origins/Uses/sources before freeze. Per-member `beforeOwnerFreeze` uses original mount save/detach with target/occupancy/commit guards. See [Environments](../../docs/architecture/environments.md); verify `test/environment/{execution-origin,origin,use-ownership,transfer-records,execution-portable,execution-source-records}.test.ts` and Local `test/session-transfer-environments-native.test.ts`.
- Environment reader three retains explicit mappings through composition-registered private source/target callbacks/final epoch commit checks. Preserve legacy bytes; mapping DTOs/history grant no authority.
- `EnvironmentResources.retainExecution` grants only original preparation cleanup to its actual committed process. Observer disposal closes new preparation; release policy/admission after native completion/saving. Reject copies; verify Local `test/environment/{preparation,process}.test.ts`.
- Metadata mutations use short claims; retirement admits only its owner. Session selection pins destinations/drains registered resources before commit; file-aware commands share binding leases. Release claims after capacity-resumption failure.

`Storage.Handle` owns [Agent authority](../../docs/architecture/agent-storage.md), transactions/content lifetimes. Prepare binaries outside SQL/checkpoints; owners publish. `withRestorationArtifacts` stages recovery bytes; verify `test/storage/restoration-artifacts.test.ts`. Drain writers/producers before closure; reopen after release. Preserve purpose/cohort holds; Home upgrades require native witnesses. Checkpoints/`assertWriteTransaction` fence callbacks. Archives require Host authority; history never authorizes. Read object v1/v2. Test storage/secrets/authority-{journal,adoption}/runtime-maintenance-{adoption,home-upgrade,source-preparation}/{maintenance-retirement-records,checkpoint-retention}; Organization: `test/backup/pending-retirement.test.ts`. SQLite: workspace-sqlite; PG: `SYNERGY_TEST_POSTGRES_URL`.

Register PG contracts in `test/support/storage-backends.ts`; see [backend selection](../../.synergy/skill/testing-guide/SKILL.md).

`StorageEventSinks` owns transactional capture and durable delivery. Optional `deliverBatch` receives at most 128 adjacent same-partition records; acknowledge the whole window only after durable acceptance. Preserve single-delivery semantics. `Storage.afterFailure` observes the original outer error only through synchronous RAM diagnostics; it never grants recovery effects. Verify `test/storage/{event-sinks,after-failure}.test.ts`.

Vault/execution-time secrets stay here; detection belongs to `packages/secret-detection`. Derived batches use `SecretMask.captureAndApplyMany`/`revision()`. Register `secrets/detector-source` replacements before startup. Capture changes run `bun test test/secrets/` and `bun run benchmark:secrets` with a disposable benchmark Home.

Check `storage/compat` before copies. Existing-only attachment validates without initialization; test `storage/existing-attach`. Central migrations own upgrades; Runtime Handle drains imports.

Preserve Snapshot ownership/`withPublishedNative`/callback-bound readers/Archive verification/paging/preparations; atomic heads/receipts. `WorkspaceMove` guards range/adoption through COMMIT/unknown outcomes; release outside SQL. Verify `test/snapshot/`, `test/workspace/{content-producer,portable-tree,archive,archive-paged,tree-import}.test.ts` and Local Runtime `test/workspace/{move,native-adoption,change-attribution}.test.ts`.

Cortex holds preserve task/root/input/budget/deadline/notification identity; never cancel/recreate/auto-resume. Transfer: `session/transfer`, `session/transfer-workspace`; verify `test/session/transfer.test.ts`, `test/cortex/{parent-abort,task-tool-abort}.test.ts`.

Portability requires atomic cohorts/epochs, ordered publication/dependencies, permanent surrender/retirement, prepared pins/`session-workspaces`/Environment owners. Verify `test/session/{transfer-*,workspace-*}.test.ts` and `test/storage/{artifact-stream,storage-binary-stream,object-artifacts}.test.ts`.

`PartContent.RecordCommitted` exposes body-free native commit identities inside the actual write transaction; verify buffered flush, rollback and removal in `test/session/streaming-persistence.test.ts`.

`SessionInbox.RecordCommitted` exposes native item identities in the admission transaction. Durable sinks retain only needed public metadata before consumption; capture failure rolls back admission. Verify `test/session/inbox-record-committed.test.ts`.

`SessionHistory`: indexed headers/fields/attachments; page children/Cortex (`test/session/{part-field-header,attachment-content,attachment-index,cortex-index}.test.ts`).

Install Assets before activation; test `test/asset/portable.test.ts`. Use decision receipts and Scope-qualified pending windows; verify permission suites.

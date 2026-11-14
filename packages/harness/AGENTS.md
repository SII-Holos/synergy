# harness Package

Own lifecycle/features/`./host/identity`; `context` owns attribution, `agent/primary-identity` primary names. See [Host connections](../../docs/architecture/host-connections.md).

- `SessionExecutionOwners` gates components through references/`MessageV2`. Preserve blocked predecessors and canonical Root/Agent admission. Views never replace writes; activity/release never recover execution. Verify `test/session/{resume,rollout-cancel,rollout-activity,rollout-pending,agent-worker-pool}.test.ts`.
- Session L/progress: `session/long-term-memory`, never workflows/Library. [State](../../docs/architecture/session-and-messages.md#session-long-term-summary).
- `SessionSchemaRegistry` owns fields/inheritance/indexes/portability/epoch adoption/notifications. Capture original body-free Info synchronously; verify `test/session/notification-source.test.ts`. Domains own execution/recovery. Seal `ConfigExtensions` before startup; retain unregistered fields outside client output.
- `RuntimeHandle` owns Host/composition/storage; seal before startup, enter through `run`/`bind`. `HomeOwnershipFile` fences readers/recovery/retirement; `lifecycle/namespace-identity` binds primary evidence. `lifecycle/home-restoration` owns permits; Node-safe metadata grants no authority. Verify `test/lifecycle/{namespace-identity,namespace-retirement,home-restoration,home-retirement-file,home-reader-advance}.test.ts`; isolate tests/migrations.
- Unsealed fixtures; settle Rollouts last. `Core.storedInfo`/`Source.retainedReceipt`: read-only.

- Hosts select `ProviderSdkSource`/`AttachmentImageInput`/`InstructionSource`/`ConfigSource`; `ProjectConfig` reads allowlisted project fields. Verify absence and `test/attachment/model-input.test.ts`.
- Instruction consumers forward Session IDs; omission preserves personal catalogs. SessionReadSource/ProcessAccessSource gate history/process access; domains own provenance/authorization.
- Local Runtime owns native PTYs/watchers/OS sandboxes. `workspace/observation` qualifies invalidations; Session owns live comparisons. Harness owns permissions/`SandboxHost`; sandboxed execution fails closed without host registration.

- Expose public domain operations; `session/prompt-budgeter` measures native messages. Host adapters use declared leaves; never export processor/resolver/scheduler/journal implementations to production. Published manifests omit `test/` exports; internal imports stay relative.
- Local Runtime owns browsing/edits; Harness owns file-source leases/receipts/evidence/locking. Remote Session bindings require actual Catalog/synchronous registered file-owner inspection; metadata never authorizes effects. Keep checkpoint journals private behind WorkspaceOperations publication inspection.
- Native imports use Runtime-scoped `workspace/file-import` Host contracts; register implementations before Runtime opening, explicitly reject unavailable hosts.
- Harness owns [resource admission](../../docs/architecture/resource-admission.md); Local Runtime supplies samples. Verify `test/resources/`.
- Workspace catalog/bindings own files. `workspace/access` owns admission/claims/callbacks/drainage; scheduling stays private. Files use `WorkspaceState`; Scope config/events use `ScopedState`. Startup declares ownership. Verify `test/workspace/access-maintenance.test.ts`.
- Tool `resourceNeeds` augments static requirements; follow `add-tool`.
- Drain Environment origins/Uses/sources before freeze. `beforeOwnerFreeze` preserves mount save/detach and target/occupancy/commit guards. [Environments](../../docs/architecture/environments.md); verify `test/environment/{execution-origin,origin,use-ownership,transfer-records,execution-portable,execution-source-records}.test.ts`, Local `test/session-transfer-environments-native.test.ts`.
- Environment reader three retains explicit mappings through composition-registered private source/target callbacks/final epoch commit checks. Preserve legacy bytes; mapping DTOs/history grant no authority.
- `EnvironmentResources.retainExecution` grants only original preparation cleanup to its actual committed process. Observer disposal closes new preparation; release policy/admission after native completion/saving. Reject copies; verify Local `test/environment/{preparation,process}.test.ts`.
- Metadata uses short claims; retirement admits its owner. Session selection pins/drains before commit; file commands share binding leases. Release claims after capacity-resumption failure.

`Storage.Handle` owns [authority](../../docs/architecture/agent-storage.md) and transactions/content. Prepare binaries outside SQL; owners publish. `withRestorationArtifacts` stages bytes (`test/storage/restoration-artifacts.test.ts`). Drain before closure; reopen after release. Preserve purpose/cohort holds/native Home witnesses. Checkpoints/`assertWriteTransaction` fence callbacks. Host authority admits archives; history never authorizes. Read object v1/v2. Test storage/secrets/authority-{journal,adoption}/runtime-maintenance-{adoption,home-upgrade,source-preparation}/{maintenance-retirement-records,checkpoint-retention}; Organization: `test/backup/pending-retirement.test.ts`. SQLite: workspace-sqlite; PG: `SYNERGY_TEST_POSTGRES_URL`.

PG contracts: `test/support/storage-backends.ts`; [selection](../../.synergy/skill/testing-guide/SKILL.md).

`StorageEventSinks` captures/delivers transactionally. `deliverBatch` accepts ≤128 adjacent same-partition records before whole-window ACK; preserve single delivery. `Storage.afterFailure` observes outer errors through synchronous RAM diagnostics, never recovery authority. Verify `test/storage/{event-sinks,after-failure}.test.ts`.

Vault/execution secrets stay here; detection: `packages/secret-detection`. Derived batches use `SecretMask.captureAndApplyMany`/`revision()`. Register detector sources before startup. Verify `test/secrets/` and `bun run benchmark:secrets` with disposable Homes.

Check `storage/compat` before copies. Existing-only attachment never initializes (`storage/existing-attach`). Central migrations own upgrades; Runtime drains imports. Retention uses original transactions/guards (`test/storage/retention-mutation-guard.test.ts`).

Preserve Snapshot ownership/`withPublishedNative`/callback-bound readers/Archive verification/paging/preparations; atomic heads/receipts. `WorkspaceMove` guards range/adoption through COMMIT/unknown outcomes; release outside SQL. Verify `test/snapshot/`, `test/workspace/{content-producer,portable-tree,archive,archive-paged,tree-import}.test.ts` and Local Runtime `test/workspace/{move,native-adoption,change-attribution}.test.ts`.

Cortex holds preserve task/root/input/budget/deadline/notification identity; never cancel/recreate/auto-resume. Owners: `session/transfer{,-workspace}`; verify `test/session/transfer.test.ts`, `test/cortex/{parent-abort,task-tool-abort}.test.ts`.

Portability requires atomic cohorts/epochs, ordered publication/dependencies, permanent surrender/retirement, prepared pins/`session-workspaces`/Environment owners. Verify `test/session/{transfer-*,workspace-*}.test.ts` and `test/storage/{artifact-stream,storage-binary-stream,object-artifacts}.test.ts`.

`session/part-commit` exposes body-free facts; `RolloutEvents.readCommitted` reads original revisions. `RolloutArtifact.iterate` pages metadata; maintenance owns tree stability. Verify `test/session/{native-commit-reader,streaming-persistence,rollout-artifact-iterate}.test.ts`.

`SessionInbox.RecordCommitted` captures admission identities. Retain needed public metadata before consumption; failed capture rolls back admission. Verify `test/session/inbox-record-committed.test.ts`.

`SessionHistory`: indexed headers/fields/attachments; page children/Cortex (`test/session/{part-field-header,attachment-content,attachment-index,cortex-index}.test.ts`).

Install Assets before activation; test `test/asset/portable.test.ts`. Use decision receipts and Scope-qualified pending windows; verify permission suites.

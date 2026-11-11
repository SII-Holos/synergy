# harness Package

Own lifecycle, features and `./host/identity`; `context` owns attribution and `agent/primary-identity` primary names. See: [Host connections](../../docs/architecture/host-connections.md).

- Keep tools, routes, config and migrations with their domain.
- `SessionExecutionOwners` gates components using references and `MessageV2` semantics. Preserve blocked records; human tasks cannot resume unavailable predecessors. Root admission and Agent selection persist independently; execution views cannot replace Session writes. Compose native receipts and observe activity/release without recovery; verify `test/session/{resume,rollout-cancel,rollout-activity}.test.ts`.
- Session L/progress: `session/long-term-memory`, never workflows/Library. [State](../../docs/architecture/session-and-messages.md#session-long-term-summary).
- `SessionSchemaRegistry` owns fields, inheritance, indexes, required portability readers and epoch-only adoption; domains own workflow state and execution/recovery policy. `ConfigExtensions` composes owner contracts; unregistered fields remain on disk but outside client output. Full composition completes schema registration.
- `RuntimeHandle` owns Host, composition and storage; seal registration before startup. Use `run` for work, `bind` for native callbacks. Persisted Home ownership must match. Node provisioning reuses `HomeOwnershipFile`. Test isolated instances and child entrypoints; keep migration listings detached.
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
- Environment/mount release ownership: [Environments](../../docs/architecture/environments.md). Verify Local Runtime's `test/workspace/mount-maintenance.test.ts`.
- Metadata mutations have short claims. Retirement admits only its owner. Session selection pins destinations and drains registered resources before commit; file-aware commands share the binding lease. Release claims when capacity resumption fails.

`Storage.Handle` owns [Agent authority](../../docs/architecture/agent-storage.md), transactions and content lifetimes. External effects precede references. Pin checkpoints; verify complete logical scans against captured manifests. Fence restores. Archives require Host authority; history cannot authorize. Read object v1/v2. Maintenance drains native/detached writers; reopen admission after confirmed release. Preserve purpose/cohort holds. Test storage/secrets. SQLite: workspace-sqlite; PG: `SYNERGY_TEST_POSTGRES_URL`.

Register PG contracts in `test/support/storage-backends.ts`; see [backend selection](../../.synergy/skill/testing-guide/SKILL.md).

Vault and execution-time secret resolution stay here; detection belongs to `packages/secret-detection`. Derived batches use `SecretMask.captureAndApplyMany`/`revision()`. Register replacement detectors through `secrets/detector-source` before runtime startup. Run `bun test test/secrets/` and `bun run benchmark:secrets` for capture changes; the benchmark owns a disposable home.

Before copying deferred datasets, use `storage/compat` convergence. Central migrations stage shared records and owner cohorts; Runtime Handle drains imports.

Summaries compare Workspace checkpoints; separate tool evidence. Use version-checked previews, versioned Snapshot ownership, paged content, opaque capture and staged restoration. Preserve uncertain preparations. Verify `test/snapshot/`, history and Local Runtime's `test/workspace/change-attribution.test.ts`.

Cortex holds preserve task/root/input/budget/deadline/notification identity; never cancel/recreate or auto-resume. Transfer: `session/transfer`, `session/transfer-workspace`; verify `test/session/transfer.test.ts`, `test/cortex/{parent-abort,task-tool-abort}.test.ts`.

Aggregate portability: drained source cohorts, epochs/streams, private Snapshot staging, declared dependencies, permanent surrender/retirement, prepared tokens/pack pins. Verify `test/session/transfer-*.test.ts`; `test/storage/{artifact-stream,storage-binary-stream,object-artifacts}.test.ts`.

`SessionHistory`: bodyless headers/versioned attachments; page children/Cortex (`test/session/{attachment-content,attachment-index,cortex-index}.test.ts`).

Install Assets before activation; test `test/asset/portable.test.ts`. Use decision receipts and Scope-qualified pending windows; verify permission suites.

# Decision Record: Preserve native Lattice history and transfer controls

Status: implemented

## Problem

Transferring only a Lattice Session descriptor loses terminal runs, native events, exact reviewed documents and pending effect identities. The older v2 reset also removed incompatible run and event records and changed document bindings without retaining their original versions. Treating every unknown schema as v1 could destroy history written by a newer owner.

## Decision

Register a versioned Lattice transfer owner over the existing Run, current pointer, event and Note owners. Derived per-Session indexes page through retained run, loop and document references. Source suspension drains the native lock, flushes pending model-call evidence and seals exact document selections. Staging validates the complete native ledger and document closure, then publishes under permanent epoch activation while the root remains paused. Publication does not execute effects or generate prompts. Independent Continue uses exact epoch evidence before native reconciliation.

Note preparation partitions its immutable version references by contributing owner as well as Session and handoff. Blueprint and Lattice can select different exact documents in one aggregate without overwriting each other's seals or pins. They continue to use one Note version store; an omitted owner preserves the original preparation namespace.

The owning legacy migration archives original run, event, Note, loop and Session records before changing them, in the same Storage transaction. The archive has immutable original-key and content digests and streams with the native Session transfer owner. Paged SQL projections replace Home-wide arrays and maps in migration discovery. Known document mutations increment their version and retain both valid old and new snapshots; older incomplete document records retain their exact raw original in the archive. An injected cleanup failure rolls back both archive and canonical changes.

Explicit unsupported schema versions remain unchanged with their bindings. The execution owner rejects Continue for an unavailable native run, and portability preflight returns a recoverable owner requirement. It does not infer effects, reset unknown data or manufacture content already deleted by historical releases. A new central maintenance migration applies these rules to input still retained after earlier migration receipts.

Model-counter flushes keep pending evidence until acknowledgement. A per-Session lock and native Storage operation receipt bind each delta to its original run. Retrying a committed but unacknowledged flush cannot count it twice; new calls remain pending for a later batch.

## Alternatives considered

**Recreate the workflow from its current document.** This changes reviewed versions and native effect identities.

**Drop unsupported records during reset.** A newer schema is not evidence that its contents are disposable.

**Copy a second active workflow table.** The existing Run, Note and Session stores remain authoritative; preparation and archives do not schedule work.

## Consequences

Real two-Home tests cover Core, Blueprint and Lattice records, current and reviewed Note versions, legacy archives, paused activation and an unchanged pending effect with no emitted prompt. Other tests cover epoch mutation fences, unsupported-schema refusal, atomic migration rollback, independent owner seals and committed-but-lost counter acknowledgements. Asset references in structured retained documents are enumerated from exact sealed content. The common evidence owner and organization handoff orchestration remain separate integrations; this decision does not assert their completion.

# Decision Record: Retain Environment Uses under canonical native owners

Status: implemented

## Problem

A resource Use prevents allocation deletion independently of the caller's Session execution authority. A new admission with an occupied Use ID must not replace a running operation's retention or obtain its cleanup authority. A ready allocation must still respect native maintenance admission.

## Decision

Every new acquisition requires an opaque native origin or a capability from its registered resource owner. Generic leases create admission Uses only. Execution, Workspace mount and Workspace operation owners mint distinct preparation, retention and retirement capabilities bound to their exact Runtime, Store configuration, target and canonical identity. They re-read their own records in the current transaction. Scope or matching string IDs do not confer retirement authority.

Origin schemas live in a pure owning schema leaf; native capture and Store guards remain in the Origin runtime. Session provenance reads the canonical persisted Session schema and the single Rollout owner factory without importing the Session facade or the complete Rollout lifecycle. Composition supplies Gate with the existing Epoch authority through bound Runtime-scoped callbacks. Gate retains its original fences and fails closed when that owner is absent; Epochs remains the sole parser and state machine.

Canonical operation or mount publication precedes retention in the same transaction. Retention changes only a validated preparation into its corresponding durable owner. An ordinary admission cannot overwrite either an admission lease or a retained operation. A mount retry may borrow its exact retained mount after canonical validation; borrowing does not rewrite the Use and its cleanup cannot remove the original retention.

Native saving and acknowledgements precede retirement. Retirement checks the original canonical resource rather than requiring its Task to remain running. A lease's ordinary cleanup compares the original SQL revision and admission data, and cannot remove an operation after an uncertain retention commit. Unknown outcomes preserve the original occupancy for reconciliation.

Uses persist in strict version-2 envelopes. The owning record migration and bounded central physical migration preserve historical data and unknown fields without inventing owners. Current admission and execution-preparation records require the Origin owner's strict current schema; nested unknown provenance cannot make a historical row disposable. Historical outer unknown Uses block native maintenance. Known abandoned admission leases may be recovered after their Runtime epoch ends; this is not evidence that a retained physical operation terminated. Maintenance drains original Execution, Workspace operation and mount owners in their existing order, then requires all Uses to be released before freezing.

The organization native Home reader is `native-organization-ownership-v3`. Earlier unpublished reader values cannot start normally. The supported published legacy Home upgrade remains explicit frozen maintenance with unchanged identity and keys. Sealed Hosted archives retain strict readers for their historical versions; archive verification cannot enable an old active worker.

## Alternatives considered

**Use ID equality as authority.** A caller could replace an existing operation with an admission and release its occupancy. Canonical owner validation and the original lease revision distinguish these lifetimes.

**Read retained records with optional ownership metadata.** An older reader discards that field, and its writer could create anonymous occupancy against an empty database. The stored envelope and independent worker reader fence address these two cases separately.

**Reject cleanup when the Task pauses.** Saving and physical release must still finish after admission closes. Original owner evidence authorizes cleanup without readmitting execution.

## Consequences

Uncertain historical ownership requires explicit native reconciliation. This unit does not provide the `session-environments` portable owner, cloud Environment mappings or complete Host consumer integration. It does not stop an already running earlier worker or prove external process termination.

## Verification

Harness `test/environment/use-ownership.test.ts` exercises retained execution collisions, ready-allocation maintenance admission, real lost SQL acknowledgements, 130 historical Uses, original lease cleanup and foreign-Store iterator escapes. Environment lifecycle and maintenance suites cover restart and provider ownership. Local Runtime mount/operation suites retain actual native save, lost-response and recovery behavior. Managed stream and history fixtures consume original resource origins; restore inherits that provenance and uses a registered Host only when no resource frame exists. Organization Runtime Node and pinned agent/policy fixtures verify current-reader refusal before readiness; frozen legacy migration and fixed historical archives retain identity. The original standalone Server import order and its Scope guards remain executable; `test/session/transfer-gate-composition.test.ts` checks missing-owner refusal before storage. See [the postmortem](../../../postmortem/0123-retained-environment-use-was-overwritten-by-admission.md).

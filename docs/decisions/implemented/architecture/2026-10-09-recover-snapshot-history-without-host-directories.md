# Decision Record: Recover snapshot history without Host directories

Status: implemented

## Problem

Session history can contain valid Git tree identifiers while their only object store belongs to a lost Host. A replacement cannot compare, restore or fork those snapshots from database metadata alone. A local retention reference must not imply that remote publication succeeded.

## Decision

Runtime composition selects snapshot persistence. The SQL-backed implementation stores self-contained Git packs as bounded binary chunks and atomically publishes their references with a root manifest under the owning Session. Uploads use the artifact backend's persisted intents and unknown-commit protection. A root becomes authoritative only after its database transaction succeeds. Session deletion removes its references; another Session's fork keeps independent references to shared immutable content.

On-demand recovery validates manifests and content checksums, imports packs with Git's strict validation, and restores the exact historical tree identifier into a disposable local repository. Snapshot capture, adoption and rollout import all publish through the same retention path. Missing remote ownership cannot be replaced by an uncommitted local reference. An explicit database format marker rejects accidental switching between local and external modes; historical conversion remains an offline owner operation.

## Alternatives considered

**Change historical snapshot identifiers.** This breaks existing messages, version previews and imports.

**Upload one unbounded in-memory archive.** Large workspaces make memory proportional to snapshot size. Four MiB chunks keep upload and restore buffers bounded instead.

**Scan every historical root at startup.** This increases admission latency with history size. Only requested roots are recovered.

## Consequences

Git remains a cache implementation, not the recovery authority. Full root closures favor independent recovery over optimal pack deltas; the byte limit is explicit (eight GiB by default), and repeated changed roots may require additional object space. This tradeoff must be included in resource acceptance measurements. No snapshot capture is required just to start a model request. The host still supplies the namespace writer lease and must stop incompatible old writers before activation.

The [persistence contracts](../../../../packages/harness/test/snapshot/persistence.test.ts) verify replacement after cache loss, historical comparison, fork independence, missing and corrupt content, partial-upload cancellation and bounded multi-chunk recovery. Existing local snapshot behavior remains covered by its retained suite.

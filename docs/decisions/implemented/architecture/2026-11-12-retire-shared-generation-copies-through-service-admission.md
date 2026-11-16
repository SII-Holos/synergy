# Decision Record: Retire shared generation copies through service admission

Status: implemented

## Problem

Stopping sharing permanently advances the Session's sharing generation, but retained service projections and uploaded copies have no explicit collection owner. Reusing native orphan collection for that logical mutation would mix service reference ownership with physical pack and object reclamation.

## Decision

The ordinary service's trusted Host maintenance handle exposes retention mark, status and collect operations for one explicit sharing generation. A version-one mark retains its original request, target, operator, deployment, delay and eventual receipt. Its request identity cannot change target or parameters. The default delay is one day; an explicit Host policy can select another positive delay. An original mark survives process restart. Marks from another deployment cannot authorize new collection, while a new explicit request can create a fresh mark without replacing old receipts.

Mark and collection enter the existing accepted service operation. Collection rechecks the actual canonical directory, generation, sharing checkpoint, deployment and handoff inside the same SQL transaction as its removals and receipt. An original callback guard remains on the actual commit. No frozen-write exception, new Kernel maintenance purpose, caller verifier or native deletion permit is added. Backup rejects fresh collection while already accepted collection remains owned through real drainage. Status reads the original mark without admitting a new mutation.

The sharing, transcript and task owners expose their generation prefixes. The retention owner visits their metadata and artifact references in bounded pages, refuses incomplete or unclassified blob state, then logically removes only the old projection, events, child projection, uploaded copy and derived indexes. It preserves the canonical directory and monotonically advancing generation, batch idempotency receipts, the mark receipt and revision tombstones. It does not enumerate a namespace-wide object set.

Logical removal queues native artifact garbage through the existing Store. Physical pack and object removal remains with the existing offline reclamation and pin owners. Published files have independent immutable references and remain available. An open native artifact checkpoint retains its original bytes after the logical sharing reference disappears. This operation does not collect published versions, Snapshot objects, WorkspaceMove bytes, handoff streams, unknown intents or their evidence.

## Alternatives considered

**Allow arbitrary SQL writes under frozen maintenance.** Logical service cleanup already has a canonical mutator and transaction owner; a new exception would enlarge authority without proving physical deletion safety.

**Delete old bytes when their sharing generation changes.** This would skip delay, current-state checks and native pins. An unavailable or incomplete owner must retain its bytes.

**Expire old receipts with the data.** Batch identities, tombstones and permanent generation fences prevent old work from becoming new work after collection.

## Consequences

The service can explicitly retire confirmed old sharing copies without changing native reclamation semantics or restoring access. Real Store tests cover restart, old-request rejection, handoff and incomplete-copy blocking, an active new-generation upload, independent publication, an open native checkpoint and backup admission/drainage. No current-generation content or canonical Session state is removed. Further GC owners and physical reclamation acceptance remain separate work; this sharing-copy operation alone does not establish full deployment GC coverage.

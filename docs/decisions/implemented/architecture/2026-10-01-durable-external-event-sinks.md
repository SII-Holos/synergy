# Decision Record: Durable external event sinks

Status: implemented

## Problem

Runtime Bus notifications belong to the current epoch. Recovery discards old notification effects to avoid repeating arbitrary subscribers. An embedded host therefore cannot use those notifications as its durable external delivery queue.

## Decision

Hosts explicitly register Runtime-owned StorageEventSinks. A pure capture callback projects selected stored events into an independent delivery record and allocates a partition sequence in the same SQL transaction as the fact. Capture is serialized within that transaction, including concurrent publications. Hosts pump bounded batches outside transactions. A record is removed only after durable external acknowledgment; native notification reconciliation cannot remove it.

Capture may await transaction-local reads to resolve persisted ownership. Its promise is awaited before the fact can commit, and a projection failure rolls the fact and queue back together. Network effects remain forbidden inside capture.

An optional captured callback receives the allocated delivery identity and sequence inside that transaction. A host can retain the minimal receipt required by a synchronous admission handshake without inspecting queue keys or duplicating sequence allocation. Callback failure rolls back the fact, sequence, queue and host receipt together.

## Alternatives considered

Replaying arbitrary Bus subscribers can duplicate external effects. Publishing from a subscriber loses events after a crash. A host-side queue written after the fact leaves a commit gap. An exactly-once network promise cannot resolve a lost response.

## Consequences

Receivers deduplicate stable sink/event identities and enforce partition order. An unavailable or absent sink retains pending records and blocks that pump. Composition, storage lifetime, pumping and drain are explicit host responsibilities; no hidden product service is started. The queue uses existing SQL records and portable storage, preserving the SQLite/PostgreSQL contract. Streaming deltas remain ephemeral; only events published inside a business transaction are captured. Tests cover rollback, concurrent capture and pumps, restart, lost acknowledgment, native epoch reconciliation and absent consumers.

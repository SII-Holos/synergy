# Decision Record: Durable external event sinks

Status: implemented

## Problem

Runtime Bus notifications belong to the current epoch. Recovery discards old notification effects to avoid repeating arbitrary subscribers. An embedded host therefore cannot use those notifications as its durable external delivery queue.

## Decision

Hosts explicitly register Runtime-owned StorageEventSinks. A pure capture callback projects selected stored events into an independent delivery record and allocates a partition sequence in the same SQL transaction as the fact. Capture is serialized within that transaction, including concurrent publications. Hosts pump bounded batches outside transactions. A record is removed only after durable external acknowledgment; native notification reconciliation cannot remove it.

Capture may await transaction-local reads to resolve persisted ownership. Its promise is awaited before the fact can commit, and a projection failure rolls the fact and queue back together. Network effects remain forbidden inside capture.

The native Inbox item writer exposes `SessionInbox.RecordCommitted` with only its original Scope, Session, item and revision identities. Sinks capture any required public notification summary and creation time from the original item inside that transaction, before later consumption removes it. This preserves notification identity across a cold delivery without copying input bodies or reconstructing their original metadata from a materialized message. An exact accepted-input retry does not create another item fact; capture failure rolls back admission and permits an ordinary retry.

Hosts import the body-free `SessionPartCommit` contract through `session/part-commit`; the private Part writer retains the same schema identity. `RolloutEvents.readCommitted` reads one exact original journal revision through the owning journal and validates its owner without recovery or a full fold. Missing original evidence fails rather than substituting a newer record. This keeps durable projection consumers within the public boundary without exporting private writers or duplicating journal keys.

An owner may register `Storage.afterFailure` inside its original live write frame to observe the actual outer transaction error through synchronous in-memory diagnostics. It also covers a later delivery-record write or final commit failure after capture returned. Observers run after the native writer exits, remain bound to the original Runtime and do not grant a new write or recovery effect. Successful commits, caught nested errors and failed post-commit notifications do not trigger them. Unknown commit outcomes remain unknown; an observer failure cannot replace the original error or prevent later observers.

An optional captured callback receives the allocated delivery identity and sequence inside that transaction. A host can retain the minimal receipt required by a synchronous admission handshake without inspecting queue keys or duplicating sequence allocation. Callback failure rolls back the fact, sequence, queue and host receipt together.

Each bounded pump acknowledges its accepted prefix in one transaction after external delivery, preserving revision checks for every removed record. A later delivery failure still commits the accepted prefix; a revision conflict rolls back the whole acknowledgment. This trades a larger possible replay prefix for fewer durable commits without holding a transaction during network calls.

A sink may implement `deliverBatch` to durably accept up to 128 adjacent records from the same sink and partition in their original query order. Each record is schema- and key-validated before delivery. Only a successful whole-window acknowledgment enters the accepted prefix; a failure retains that entire window, including when the receiver committed before losing its reply. Revision checks and stable event identities remain the acknowledgment and deduplication boundaries. Sinks using `deliver` keep their original single-record behavior. Hosts must not assume that the generic query groups different partitions together.

An explicit pump may select one sink and optionally one partition through the original queue prefix before its bounded query. A partition requires its sink identity. Selection neither grants delivery authority nor changes acknowledgment checks; a blocked partition keeps its records while a healthy selected partition can progress. An empty selected result proves only that selected queue is empty, never that the Runtime has drained all deliveries.

## Alternatives considered

Replaying arbitrary Bus subscribers can duplicate external effects. Publishing from a subscriber loses events after a crash. A host-side queue written after the fact leaves a commit gap. An exactly-once network promise cannot resolve a lost response.

Per-record acknowledgment commits narrow the replay window but multiply transaction overhead across an already bounded delivery batch. Atomic prefix acknowledgment retains the same receiver deduplication requirement and bounds replay by the pump limit.

## Consequences

Receivers deduplicate stable sink/event identities and enforce partition order. An unavailable or absent sink retains pending records and blocks that pump. Composition, storage lifetime, pumping and drain are explicit host responsibilities; no hidden product service is started. The queue uses existing SQL records and portable storage, preserving the SQLite/PostgreSQL contract. Streaming deltas remain ephemeral; only events published inside a business transaction are captured. Tests cover rollback, concurrent capture and pumps, restart, lost acknowledgment, native epoch reconciliation and absent consumers.

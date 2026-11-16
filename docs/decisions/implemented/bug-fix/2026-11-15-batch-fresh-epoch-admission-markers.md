# Decision Record: Batch fresh epoch admission markers

Status: implemented

## Problem

Every native Session mutation checks transfer epochs through the current write transaction. The epoch reader separately fetches its reservation, current pointer and Session index, and ordinary scheduling also fetches the source intent. These independent marker reads dispatch three or four native statements before any dependent parent, aggregate-root or handoff-state reads. Repeated native message and Part writes amplify those round trips.

## Decision

Read the current operation's three or four independent markers together through `Storage.readMany()`. The existing native transaction supplies mutation admission, including its own uncommitted changes. Outside that transaction, Storage supplies one statement snapshot for the marker batch. Every later guard reads the markers again; no absence, parsed row, authorization decision or transaction-wide result is cached.

Parse marker schemas only when the original branch reaches them: reservation, current pointer, optional source intent, then Session index. Reservation and uncertain-pointer short circuits retain their meaning for valid and schema-malformed later records. Source-intent binding validation and its dependent handoff-state read remain before index parsing. Parent ancestry, aggregate-root state, cycle fencing, the current source epoch and its retained handoff state retain their original dependent reads and checks. Owner-mutation admission still excludes the scheduling-only source intent.

Storage decodes the entire marker batch before schema inspection. A physically corrupt additional marker therefore fails the whole snapshot with the original `StorageIntegrityError`, including when an earlier valid marker already establishes a frozen state. This strict snapshot integrity is intentional: corruption never supplies an admission grant, and no error is caught, replaced, repaired or retried through a fallback decoder. Historical short-circuit precedence for an unread physical codec error is not retained.

## Validation

The existing transfer-epoch fixture measures actual native statements inside its original write transaction: an absent-index scheduling check reads four markers in one statement, and owner mutation reads its three markers in one statement. A paused real Session with a draining source intent verifies that accepted owner writes remain permitted, a same-transaction uncertain fence blocks the next write, removal permits the next write, and rollback restores admission without retaining a cached result. Corruption controls preserve lazy schema precedence and verify that corrupt physical encoding prevents both inspection and mutation. Existing surrender, return activation, permanent destination retirement and legacy upgrade coverage remain intact.

## Alternatives considered

**Keep separate point reads.** This preserves historical physical-corruption short circuits but retains independent native round trips on every admission check.

**Memoize admission or decoded markers.** A same-transaction fence installation, removal or rollback must affect the next check. Reusing a prior result would require invalidation machinery and could admit a forbidden write.

**Add deferred decoding to storage.** Preserving unread physical-corruption precedence would require a new storage contract. The bounded batch instead retains the existing decoder and explicitly rejects an incomplete marker snapshot.

## Consequences

The ordinary marker lookup falls from four statements to one, or from three to one for owner mutation. An existing Session's dependent parent metadata read remains separate. Valid frozen states may fetch additional marker bodies before returning; physically corrupt bodies fail closed as described above. There is no persisted representation, RPC, queue, workload or deadline change. Native query reduction is a work bound, not proof of the full synchronization capacity deadline or a host-independent latency improvement.

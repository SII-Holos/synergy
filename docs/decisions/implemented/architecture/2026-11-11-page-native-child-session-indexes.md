# Decision Record: Page native child Session indexes

Status: implemented

## Problem

The child page API sliced one complete parent record after reading every child entry. Sibling mutations also rewrote that complete array. A bounded response therefore did not bound metadata residency, and portable child enumeration inherited the same hidden cost. Deferred historical Sessions added another whole-Scope array before filtering their parent.

## Decision

Store one version-2 header with total and active counts, individual identity rows and seekable activity-order rows. Canonical Session mutations update their child projection in the same SQL transaction. Parent moves, archive changes and removal update every affected row and count together. Complete index reconstruction writes child rows incrementally instead of retaining a whole parent map. These records remain derived from canonical Session ownership.

Membership writes consult the parent's native epoch and legacy transfer reservation/gate in that same transaction. A final frozen parent cannot gain, lose or move children even when the child has no transfer pointer. Native draining retains its existing tail-write semantics. These checks reuse the existing execution owners and do not create another transfer state.

The owning versioned migration replaces an exact version-1 parent array atomically and is also registered with the central maintenance runner. Ordinary reads invoke the same owning upgrade, rather than interpreting a parallel legacy format. Unknown versions and changed owner identities fail. Missing headers cannot authorize leftover rows. Migrating a historical monolithic record still requires reading that old record once; subsequent pages and mutations do not.

Child pages default to fifty entries and retain continuation after removal of the cursor's child. Sortable finite numeric time encoding preserves fractional timestamps; ID ordering agrees with cursor comparison. Search scans bounded metadata pages while retaining only its result window. Historical pending metadata streams from its canonical compatibility catalog and merges by exact child identity without materializing the whole Scope.

Directory reads of deferred Sessions use their existing compatibility metadata instead of reading unadmitted canonical bodies or runtime-only long-term-memory fields. Known-scope observation paths iterate metadata directly, avoiding a Session lookup that would run owner migrations inside a read-only activity snapshot. Legacy index preparation remains explicit when a read-only observer cannot upgrade it.

`Session.childEntries()` provides cancellable metadata iteration for native graph consumers. The explicit complete `Session.children()` operation retains its complete-result semantics and performs one batched client enrichment. Neither interface creates a second child authority or a lifetime child quota.

## Alternatives considered

**Slice the existing array earlier.** Storage must still decode the full parent record before slicing it.

**Create a separate organization child directory.** It would duplicate native ownership and diverge after parent moves or archives.

**Remove the complete children API.** Existing native consumers explicitly request a complete result and rely on its batched enrichment; a separate bounded iterator serves streaming consumers.

## Consequences

Real temporary storage covers fresh and historical records, exact counts, search, removed cursors, cancellation, unknown versions, parent moves and sibling write serialization. A 1,300-child fixture traverses bounded pages without duplicates while preserving one enrichment batch for the explicit complete read. Search work remains proportional to matching metadata inventory; its resident result size stays bounded. This change does not complete organization task navigation, aggregate child-edge sealing or signed handoff acceptance.

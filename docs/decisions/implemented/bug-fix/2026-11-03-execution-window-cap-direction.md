# Decision Record: Keep the newer tail when capping an execution trajectory

Status: implemented

## Problem

Live history merges and the expanded-branch resident budget capped a sorted trajectory by keeping its prefix. On the time order that prefix is older, so the dropped suffix was newer than every row that remained. A repeated withheld branch id also incremented a numeric pending count, and removing that id left the count in place. Readers could lose the newest admitted rows while the new-events notice drifted away from the ids it claimed to represent.

Explicit previous-page loads are a different operation: they admit an older span and may evict the far end of that combined page so the rows just requested stay visible. The message window uses the same prefix cap only for that older-page prepend, and tracks unseen messages by id.

## Decision

`mergeExecutionWindow` caps every mode by retaining the suffix of the sorted window. `droppedIds` is that older prefix, and each dropped row orders before every kept row under the same comparison. History mode still withholds ids that were not already resident and reports each of them once in `addedIds`. The trajectory and each expanded branch store `pendingIds`. A withheld id is recorded once; admitting the row, dropping it from the resident window, or removing the id deletes that entry. The cross-branch budget still walks the least recently updated branches first, and now removes each branch's older prefix instead of its newer tail. It does not mark a forward page that the server did not return. Explicit previous-page admission still keeps the older span it just loaded. Message-window pending and replace are unchanged.

The resident bound and the reading-position rule are in [frontend data sync](../../../architecture/frontend-data-sync.md).

## Alternatives considered

**Keep the history prefix and record a tail gap, as message prepend does.** That preserves an older reading span when the user asks for an earlier page. A live history merge and a branch memory budget are not that request. They were discarding rows newer than the ones left on screen. Recording the loss does not put the newer tail back.

**Decrement a numeric pending count when an id is removed.** A second event for the same withheld branch id would still add another notice. Membership in `pendingIds` matches the message window's unseen-id set without changing that window's pending or replace path.

## Consequences

Resident caps no longer hide a newer tail behind older rows. A reader parked on the oldest rows can lose that prefix when the shared budget shrinks; previous-page controls still extend the older span. The new-events count is the number of distinct withheld ids. Duplicate updates do not increase it, and deleting one id removes one notice. Message-window prepend, replace, and pending ids stay on their existing path.

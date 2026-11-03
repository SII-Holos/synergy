# Decision Record: Pending ids are newer than the window

Status: implemented

## Problem

History mode parked every message id that was not already in the loaded window into `pendingLatestIds`. After a cap, an older id that the window had never shown was treated as an unseen latest arrival. That id reduced the history-page total, set `pendingLatest` so bottom-return recovery refetched latest, and made inbox materialization treat the queued item as already consumed. The bounded model recorded the same step: publish `1`–`4`, load latest `{3, 4}`, prepend `2`, then reconcile `1`, and `pending` became `{1}`. `CandidatePendingIsNewer` was that trace's refuted claim.

## Decision

`pendingLatestIds` contains only ids strictly newer than the maximum message in the current window, ordered by `time.created` then `id`. An older id that is only absent is not inserted and is not pending. A later reconcile of that same id drops it if it was still listed. A message that enters the window, or is removed, leaves the list. An empty window has no maximum: a reconcile does not admit an id, and it does not drop ids already pending.

`planMessagePageApply` subtracts the length of that list from an older-page total. `shouldRecoverToLatest` sees `pendingLatest` only when the list is non-empty, and `isInboxItemMaterialized` treats membership in the list as materialization. Both follow the list, so an older absent id does not recover to latest or count as materialized.

`InvPendingIsNewer` in [spec/tla/MessageWindow.tla](../../../../spec/tla/MessageWindow.tla) is a checked invariant of `MessageWindow.cfg`. `CandidatePendingIsNewer` is the same formula. `InvPendingStep` admits a history id only when it is newer than the window maximum. The reducer test replays the former counterexample and asserts that `m1` stays out of `pendingLatestIds`, while `m5` stays in and is the only id subtracted from the page total.

## Alternatives considered

**Keep parking every unseen id.** Rejected because an older hole then reduces the displayed total, triggers bottom-return recovery, and hides an inbox item that is not a new arrival.

**Store a timestamp beside each pending id and re-check the whole list on every cap.** Rejected because the list is ids only. Admission and the next reconcile of that message decide membership; ids whose messages are not on hand stay until they enter the window or are removed.

## Consequences

A history window can sit below the true latest messages and still ignore older ids outside it. The displayed total drops only for ids newer than the window. Bottom-return recovery still runs for a tail gap or for those newer ids, and inbox materialization still treats those ids as consumed. The rule is also stated in [Frontend data sync](../../../architecture/frontend-data-sync.md#history-mode). It does not change the history cap, execution-trace cap, Kanban replace, or part repair. The history-cap record's pending sentence points here: [history cap keeps the newer tail](./2026-11-02-history-cap-keeps-newer-tail.md).

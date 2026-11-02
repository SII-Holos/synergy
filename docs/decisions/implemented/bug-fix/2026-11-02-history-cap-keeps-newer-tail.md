# Decision Record: History cap keeps the newer tail

Status: implemented

## Problem

Loading earlier messages capped the session history window by keeping the oldest ids and dropping the newest. After that cap, the greatest id in the window was lower than it had been, so the latest messages disappeared while the user was still reading history. `tailMissingLatest` then treated that drop as a tail gap. The bounded model recorded the same step: a latest window `{3, 4}` prepended `2` and became `{2, 3}`.

## Decision

`capHistoryMessages` keeps the newest `cap` messages of the merged, canonically ordered slice. Every dropped id is older than every id that remains, and the greatest id does not fall. `prependOlderPage` still removes kept and evicted ids from `pendingLatestIds`, and it preserves `tailMissingLatest` instead of setting it because oldest overflow was dropped. An explicit older-location replace still clears the current messages and sets `tailMissingLatest` before that prepend, so a jumped-to older location still records that the window is short of the true latest.

`InvHistoryCapKeepsNewerTail` in [spec/tla/MessageWindow.tla](../../../../spec/tla/MessageWindow.tla) is a checked invariant of `MessageWindow.cfg`. It states the same rule: after a prepend, the window is the newest `Cap` ids of the combined slice, every evicted id is older than every remaining id, and the maximum id is at least the pre-cap maximum. The reducer test replays the former counterexample and asserts that `m4` stays visible. Pending ids stay every unseen id; that rule is unchanged.

## Alternatives considered

**Keep dropping the newest overflow and only document it.** Rejected because scrolling history then hides the latest messages, which is the failure this invariant exists to prevent.

**Keep only the single greatest id and fill the rest of the cap with the older page.** Rejected because that still drops messages newer than ones that remain. The user-visible tail is the newer suffix, not one id.

**Narrow pending ids to ones newer than the window.** Rejected because that is a different claim. Inbox materialization treats `pendingLatestIds` as every unseen id, and the history-cap rule does not require changing it.

## Consequences

A history prepend that fits under the cap still shows the older page and the previous window. When the combined slice exceeds the cap, the oldest ids are the ones that leave, including the oldest part of the page just loaded. Once the window is already the newest `cap` messages, a further older page does not enter it; the page cursor still advances. `tailMissingLatest` stays false when a prepend drops only oldest overflow, so bottom-return recovery does not treat a full newest suffix as a missing tail. The location replace path still sets the flag. The rule is also stated in [Frontend data sync](../../../architecture/frontend-data-sync.md#history-mode) and [the message-window model](../../../../spec/tla/README.md).

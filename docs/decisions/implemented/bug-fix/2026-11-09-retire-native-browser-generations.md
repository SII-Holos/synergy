# Decision Record: Drain retired native Browser generations

Status: implemented

## Problem

A broker's old native callback can arrive after reconnection and use the same canonical page ID as its replacement. Native popup creation also runs outside the broker's command queue, so closing only acknowledged page handles can return while an unacknowledged popup is still being prepared. Temporary profile cleanup can clear a partition while another page using it is being created.

## Decision

Every broker connection owns a native lifetime signal. Native page creation and popups inherit it. Retiring a connection aborts that signal before cleanup, and the shared page pool drains only that lifetime's pending creations and pages. Pool destruction retires the whole pool and waits for all its reservations. A creation completed after retirement closes its native generation before settling; a retired opener cannot admit a new popup.

Broker callbacks capture the connection epoch. Retired events cannot modify or report a replacement page, and a late popup cannot enter the new connection's catalog. Closing an ordinary opener leaves its live popup independent because it does not retire the broker lifetime.

Temporary partitions count both admitted pages and active creation reservations. The last release clears the actual Chromium session, including a failed or cancelled final creation. A new creation waits for an already-running clear before allocating its native view. Cleanup remains tracked after a page leaves the page map, and unrelated members do not wait for each other's creation barriers.

## Alternatives considered

**Close only the broker's recorded page handles.** This cannot drain a native popup that has not reached its publication callback, or an unfinished native page creation.

**Use the stable owner key as the cleanup generation.** A replacement connection can reuse that key. A separate lifetime identifies the retiring resources without closing their successors.

**Clear whenever the final admitted page closes.** Creation reservations also use the partition. Ignoring them can delete data under a new page; ignoring failed reservations can retain temporary data indefinitely.

## Consequences

Behavior tests hold creation, popup initialization and physical storage clearing across retirement. They verify same-ID replacement safety, another member's independent progress, failed final creation cleanup and rejection of new work after pool destruction. A real Electron member broker holds a popup's native debugger initialization and verifies that member close waits for the popup's WebContents to be destroyed. Canonical protocol identities, persisted profile names and ordinary opener independence remain intact.

# Decision Record: Memoize SessionTurn timeline projection per message

Status: implemented

## Problem

Streaming replies kept the renderer main thread saturated long after the row-keying and non-keyed-timeline fixes removed row remounts. Runtime evidence from the desktop renderer showed long-task p95 of 600ms and token paint p95 of ~584ms while streaming, with the busy thread executing JIT code and allocating heavily. In `session-turn.tsx`, `timelineItems` re-projected the entire turn on every part delta: `projectAssistantMessage` ran for every assistant message in the turn, allocating fresh display-item objects even for settled messages whose parts never changed, and the element-wise `same` guard could not short-circuit because every projection returned new references. `markdownText` additionally re-joined the accumulated reply text on every delta.

## Decision

Split the turn projection into per-message memos so a delta re-projects only the message whose parts changed:

- `displayItemProjections` is a `mapArray` over the display messages; each item is a `createMemo` that projects exactly one message (user-message chip or assistant timeline items). Accessor identity is stable while the message list is unchanged, so a part delta invalidates only the owning memo.
- `timelineItems` concatenates the per-message accessor outputs, subscribes to `working()` directly so settlement re-projects once, and keeps the `equals: same` guard. Streaming deltas now hit the guard with stable references for every unchanged message and short-circuit the snapshot, boundaries, and slot-index chain.
- `latestAssistantTimelineItems` reuses the per-message accessor for the latest assistant instead of projecting it a second time per tick.
- `markdownText` returns early while `working()` — Copy Markdown is only presented after settlement, so a streaming delta no longer re-joins the accumulated text.
- The balanced-mode live reasoning scan builds its map only when compact reasoning is active and the turn is working.

Coverage: `session-turn-projection-memoization.dom.test.ts` mounts a turn with one settled and one streaming assistant, counts tool-renderer lookups on the settled message, and asserts that streaming deltas do not re-project it while settlement re-projects it once and reveals the copy action.

## Alternatives considered

- **Key the projections by message id in a plain Map** — rejected: Solid store writes would still invalidate the `timelineItems` memo through its `data.store.part` reads, so the Map entries would be rebuilt inside an already-dirty memo; `mapArray` gives each memo its own reactive owner so invalidation stops at the changed message.
- **Cache with a part-content fingerprint** — rejected: the store returns stable proxies for unchanged objects, so a reference-based cache plus per-message memo ownership achieves the same effect with no hashing cost and no stale-fingerprint risk.
- **Leave `timelineItems` unsubscribed from `working()`** — rejected: full-mode settlement re-projection (reasoning promotion/hiding) depends on the flip, and the explicit subscription keeps that behavior with a single re-projection per settle.

## Consequences

A streaming delta now re-projects one message instead of the whole turn, and the downstream snapshot/boundary chain stays dormant between deltas. Settlement re-projects each message exactly once. The per-message memo layer adds one `mapArray` indirection whose accessors are allocated once per message list change. Tool-renderer resolution and permission reads stay inside the per-message memos, so their invalidation behavior is unchanged except that unrelated-message deltas no longer touch them.

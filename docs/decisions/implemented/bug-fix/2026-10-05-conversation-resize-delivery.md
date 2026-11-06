# Decision Record: Conversation resize delivery

Status: implemented

## Problem

Loading historical bodies and expanding command groups changes dimensions inside nested virtualizers. The pinned virtualizer publishes reactive size updates during ResizeObserver delivery, changing an observed ancestor before delivery completes. Process chrome and the outer conversation also mix geometry reads with layout writes. Repeated layout and undelivered resize notifications make otherwise fast transcript requests feel jerky.

Deferring notifications also separates their observation from publication: a hidden list can report zero sizes and reappear before that batch publishes. Accepting those entries after reappearance overwrites cached row heights and loses the history position and return focus.

## Decision

The Solid entrypoints of Virtua 0.42.3 carry a pinned patch that retains the latest resize entry per target and publishes all entries in one Solid batch on the next animation frame. Unobserving a row removes pending entries, and disposal cancels queued delivery. Application-owned conversation and process observers also coalesce their work on animation frames, read geometry before changing reactive chrome, and skip unchanged process height limits. Settled disclosures skip layout measurement. Large process windows allocate their expanded height once and animate opacity during disclosure and exit; individual rows retain height motion. Local following and history anchoring stay in place.

The patch adapts the [upstream resize-delivery implementation](https://github.com/inokawa/virtua/blob/0.42.3/src/core/resizer.ts) and addresses the scheduling constraint recorded in [upstream issue 470](https://github.com/inokawa/virtua/issues/470). Its provenance, entrypoint coverage and removal criteria live in [Dependency patches](../../../../patches/README.md#virtua-solid-resize-delivery). Current geometry invariants live in [Frontend data sync](../../../architecture/frontend-data-sync.md#demand-driven-resources-and-content).

Notifications with zero width and height are rejected during delivery only when their target has no layout boxes. This preserves cached dimensions across hiding and reappearance while still accepting visible zero-size targets. Browser fixtures give navigation its own bounded preparation budget and resolve virtual lines and their geometry atomically, retaining their interaction and anchor assertions.

## Alternatives considered

**Coalesce only application observers.** This reduces redundant local work but leaves virtualizer size updates inside observer delivery, so the browser regression still reports undelivered notifications.

**Remove all process disclosure motion.** This reduces resize traffic but discards useful visual feedback and leaves the same scheduling problem during history hydration and viewport resizing. Stable-size opacity transitions retain feedback without repeatedly resizing virtualized windows.

**Reject every zero-size notification.** This would suppress legitimate collapsed or empty viewport measurements. Admission checks the absence of layout boxes only for all-zero notifications instead.

## Consequences

Virtualizer measurements become visible on the next animation frame rather than synchronously inside observer delivery. This trades one frame of measurement latency for bounded publication and avoids resizing observed ancestors during delivery. Expanded window space appears immediately and leaves after the opacity exit finishes, rather than changing height on every frame. The dependency patch requires checking both published Solid entrypoints after upgrades. Browser regressions capture ordinary window error events, verify nested layout settlement and retain the existing anchor, keyboard, disclosure and Markdown identity checks.

Hidden all-zero targets require an additional layout-box read during notification admission; ordinary positive measurements do not. Both entrypoints cover hide/show measurement retention, and the persistent-event trajectory regression verifies return position and keyboard focus.

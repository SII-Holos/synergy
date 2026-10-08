# Decision Record: Conversation layout publication

Status: implemented

## Problem

Recorded conversation interaction still incurred long style and layout tasks after pending row reservation and disclosure lifetime fixes. Focus events published identical retention arrays, retracing the complete summary projection. Resize publication queried `offsetParent` after reactive mutations. Selection checks used Blink's layout-updating `Selection.isCollapsed`. Layout bindings reread widths during mount and release, and the host scroll spy rescanned geometry already owned by its virtualizer. These reads repeatedly paid for pending subtree changes. [The postmortem](../../../postmortem/0060-conversation-layout-flushes.md) records the evidence and its limits.

## Decision

Disclosure transitions prepare in one microtask before paint. All queued targets read current painted geometry and motion tokens, then release old animations, measure natural targets and finally start new animations. No target starts animating while another target still needs measurement. New intent replaces its queued preparation; an unpainted open/close pair settles without an entrance, and a reversal returning to the playing target continues that animation. Disposal and reduced motion remove queued references, and disposed motion cannot reactivate. Focus/inert accessibility changes remain immediate; interrupted motion retains its painted height and opacity.

Interaction retention compares membership and publishes root, batch and row changes in one Solid batch. Unchanged per-root disclosure state preserves the accepted state map. Focus-out uses its destination rather than temporary document-body focus. A shared DOM-range helper protects Markdown replacement, stream motion and virtual retention using `Range.collapsed`, preserving multiple ranges without calling `Selection.isCollapsed`.

Conversation bindings consume their owner's observed width. The outer owner measures before admitting its virtualizer; a process admits its virtualizer after the viewport publishes a positive width. Cache restore and release do not query DOM width. Identity, exact ordered keys and width remain mandatory cache fences, and a mounted width change invalidates reuse.

Virtua Solid publishes captured ResizeObserver rectangles in its frame batch. Delivery filters hidden boxes before queuing; publication checks connection and observation membership without reading `offsetParent`. Visible fixed-position viewports receive measurements. Native hit testing stays enabled during scrolling, avoiding inherited pointer-event changes across the whole list. Explicit measured Markdown handoff retains its synchronous measurement transaction. Both shipped Solid entrypoints carry the patch.

The virtual conversation reports its reading root using accepted row offsets, its leading margin and the existing 100px inset. The host accepts an optional message ID on the existing public scroll-spy callback. A fully materialized nonvirtual presentation retains the original one-argument contract; the bounded presentation does not schedule that DOM scan. Canonical message order and body admission remain unchanged.

Part leases retain existing cancellation and byte budgets. This correction changes measurement and interaction publication rather than adding delayed cancellation, retries or permanent body retention.

## Alternatives considered

- Disabling motion removes spatial continuity without addressing projection work or forced measurement.
- Delaying cancellation or adding retries hides unstable membership and increases retained work.
- Repeated DOM scans duplicate the virtualizer's measurement owner; the bounded renderer reports accepted offsets.

## Consequences

Unchanged interaction membership does not retrace summaries, ordinary resize publication does not query live layout, and reading position uses the accepted row cache. Initial process admission waits for its first positive width; pending reservation and normal ResizeObserver delivery provide its geometry. Required native scroll, disclosure reversal and measured Markdown handoff reads remain explicit. A short trace cannot establish an unbounded-memory leak; collected heap baselines and repeated disposal are separate verification.

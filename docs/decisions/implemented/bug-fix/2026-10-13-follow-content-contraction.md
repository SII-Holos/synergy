# Decision Record: Follow content contraction without repeated clamp compensation

Status: implemented

## Problem

When a completed process collected above an already visible answer, the browser clamped its scroll offset to the shorter content. Following motion reconstructed the old scroll offset and applied that change again as a transform. Real-provider acceptance exposed a large upward excursion followed by a rebound. Existing conversation fixtures omitted the presentation transform; a synthetic shrinking container kept its text fixed instead of removing preceding content.

Live tool generation also reserved a compact body line while an empty pending or generating tool was fetched. Its resolved body had no displayable input, so the reserved line disappeared before the actual tool step arrived. The inner virtualizer independently estimated the same empty row as a full line, so removing only its CSS reservation still produced a one-frame collapse before ResizeObserver corrected its size. Both created a separate short collapse and expansion below the latest progress paragraph. An empty live continuation also inserted a loading line between assistant-message creation and its empty first page, then removed it before text arrived.

## Decision

Following motion records the viewport height with its last canonical offset. Native clamping contributes only the amount attributable to viewport growth, bounded by the observed clamp. Content contraction does not add another compensation. Unchanged destinations still update that baseline, and in-flight offsets retain their existing timing and reading-interruption behavior.

Conversation regression fixtures include the production hierarchy: a geometry owner with clipped overflow and a separate presentation target. Terminal collection tests sample visible answer identity and position after layout. Browser motion tests combine preceding-content contraction, viewport growth and an existing transition.

Grouped tools still waiting for generated input use their existing activity header while body content is pending; both the virtual estimate and unresolved body reserve only their existing row gap, without an additional body line. Other unresolved process content retains its existing compact reservation. Real component tests append both pending and generating tools, sample their first painted frames, then delay their body hydration. They require no downward rebound on arrival, unchanged height on hydration, completed hydration and a preserved paragraph.

Empty live continuations keep their page-read lifecycle without adding a loading line; the existing turn status represents waiting for the model. Historical page loading retains its local placeholder. A delayed empty-page test verifies the request still completes, the placeholder adds no gap and the previous paragraph remains mounted.

An empty-to-populated conversation is initial admission, not a historical prepend. The prepend predicate requires an existing retained suffix with at least one row. Otherwise the virtualizer stays in shift mode while the short conversation has no native scrolling, deferring new-row measurements until the first overflow. A browser regression starts with an empty mounted conversation and samples the first overflowing tool activity, preserving the separate populated-history prepend tests.

## Alternatives considered

**Skip compensation only while a disclosure marker exists.** Immediate virtual-row removal and the final resize can arrive after that marker disappears. It also misses simultaneous viewport growth.

**Disable all following animation.** This removes ordinary incremental following and does not distinguish a legitimate viewport correction from repeated content compensation.

**Compensate phantom tool-body removal with another reading anchor.** The empty body should not reserve space in the first place. Correcting that reservation avoids an unnecessary collapse/expansion and additional conversation geometry reads.

## Consequences

The answer follows native bottom clamping through process collection without leaving the viewport and returning. Composer and window resizing retain compensation for their own geometry changes. The helper stores one additional height and performs no content traversal. Tests preserve reduced-motion, distant navigation, transition retargeting and reading interruption coverage.

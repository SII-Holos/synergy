# Decision Record: Follow content contraction without repeated clamp compensation

Status: implemented

## Problem

When a completed process collected above an already visible answer, the browser clamped its scroll offset to the shorter content. Following motion reconstructed the old scroll offset and applied that change again as a transform. Real-provider acceptance exposed a large upward excursion followed by a rebound. Existing conversation fixtures omitted the presentation transform; a synthetic shrinking container kept its text fixed instead of removing preceding content.

## Decision

Following motion records the viewport height with its last canonical offset. Native clamping contributes only the amount attributable to viewport growth, bounded by the observed clamp. Content contraction does not add another compensation. Unchanged destinations still update that baseline, and in-flight offsets retain their existing timing and reading-interruption behavior.

Conversation regression fixtures include the production hierarchy: a geometry owner with clipped overflow and a separate presentation target. Terminal collection tests sample visible answer identity and position after layout. Browser motion tests combine preceding-content contraction, viewport growth and an existing transition.

## Alternatives considered

**Skip compensation only while a disclosure marker exists.** Immediate virtual-row removal and the final resize can arrive after that marker disappears. It also misses simultaneous viewport growth.

**Disable all following animation.** This removes ordinary incremental following and does not distinguish a legitimate viewport correction from repeated content compensation.

## Consequences

The answer follows native bottom clamping through process collection without leaving the viewport and returning. Composer and window resizing retain compensation for their own geometry changes. The helper stores one additional height and performs no content traversal. Tests preserve reduced-motion, distant navigation, transition retargeting and reading interruption coverage.

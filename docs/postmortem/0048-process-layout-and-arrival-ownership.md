# Process layout and arrival ownership

## Executive summary

Conversation process expansion jumped when overflow added 32px of vertical padding and changed available width, then a resize observer requested latest following. Historical remounts replayed entrances because mounting stood in for arrival, and empty reasoning summaries exposed unusable controls. Tests exercised settled disclosure states without sampling the threshold or separating live acceptance from remount. Geometry, reading intent and arrival ownership require independent verification.

## Summary

The same expanded content changed frame dimensions when it first overflowed. Manual reasoning disclosure did not pause following before that transition, so reader intent was lost. A secondary regression appeared during restoration: aligning a grouped virtual row restored its first tool rather than the saved nested Part, shifting the reading position by four tool rows.

## Timeline

- 2026-10-05: Behavioral tests reproduced empty reasoning rendering, manual reading loss, width change at overflow and historical entrance replay.
- 2026-10-05: Geometry and receipt changes passed those regressions; the existing prepend/reopen test detected the grouped-row restoration offset.
- 2026-10-05: Restoration used the concrete Part position with the owning virtualizer, preserving local and outer reading through prepend and reopening.
- 2026-10-05: Full frontend regression exposed a 242px shift after a later fragment loaded in the same virtual row. Slower rendering reproduced the ordering failure; a content-mutation guard preserved the concrete fragment through subsequent measurements.

## Root cause

Conditional overflow styling made measurement change the layout it measured. Following eligibility depended on overflow and proximity to the bottom rather than explicit reading intent. Mount lifecycle did not distinguish snapshots and virtual remounts from foreground live additions. Cached render summaries lacked an upgrade when the empty-content rule changed. Row identity alone was insufficient to recover a Part inside a multi-tool row. Production validation also exposed a body-lease race: reconnect invalidated hydrated content before a mounted row had observed its first ready summary page. Renewal depended on that prior observation, leaving an already resolved lease attached to an evicted body. A delayed first-page fixture now verifies same-version body renewal after invalidation, and navigation acceptance waits beyond the recovery interval.

Same-version body hydration exposed a separate ordering failure. A virtual row changed height before its container reflected the measurement, and the virtualizer's scroll compensation could arrive after the reading guard released. The resulting scroll event replaced the saved fragment with the displaced position. Summary revision and container resize alone could not announce every body change. Content mutation now starts the existing restoration guard before virtual measurement commits.

## Guardrails added

- [Process DOM tests](../../apps/web/test/components/session/conversation-process-disclosure.dom.test.ts) sample disclosure frames, actual width, reading position, live arrivals, historical remount, narrow columns and reduced motion. CPU-throttled hydration above and below a grouped fragment verifies that later compensation cannot replace its anchor.
- [Scroll tests](../../packages/ui/test/hooks/create-auto-scroll.test.ts) separate manual reading from resize and compensated scroll, and fence viewport replacement.
- [Arrival tests](../../apps/web/test/context/part-arrival.test.ts) reject baseline, replay, discovery, duplicate, expired and foreign receipts with bounded storage.
- [Session tests](../../packages/harness/test/session/reasoning-display-migration.test.ts) invalidate owner-local prepared indexes and imports while preserving canonical encrypted evidence.
- [Frontend guidance](../../.synergy/skill/develop-frontend/SKILL.md) requires invariant overflow geometry, pre-mutation capture and concrete Part offsets.

## Lessons

Measure during transitions, not only after settling. Manual disclosure is reading intent even when content still fits. Restore the actual nested Part through its virtualizer. Live acceptance, DOM lifecycle and body hydration are distinct events. Presentation-cache upgrades belong to the owning registered migration.

# Decision Record: Separate Agenda arrangements, rules and execution history

Status: implemented

## Problem

The rule list shares date navigation with calendar occurrences even though selecting a date does not filter those rules. Manual and event-triggered tasks appear as undated calendar to-dos, while paused rules are expanded into apparently valid arrangements. A clicked occurrence opens rule details without its date. Trigger times lack execution durations, so fixed time blocks introduce misleading geometry and unreadable collision lanes.

## Decision

Agenda has three peer destinations: Arrangements, Tasks and History. Arrangements contains only predicted future occurrences of enabled time-triggered rules. Its default list covers seven civil days from the selected date; day, week and month retain the same selected date while displaying their own ranges. Tasks manages every rule independently of dates, including manual, event-triggered, paused, not-enabled and finished rules. History groups actual runs by their occurrence date, newest first, within an explicitly selected Scope.

One range button opens the date picker. There is no persistent second mini-calendar or undated to-do area. Day arrangements are readable point rows. Wide week views group those rows by day; constrained containers use a week overview and the selected day's list. Month views expose date selection and a complete selected-day list, with counts replacing cramped event text below 640px. These lists express trigger order without implying a run duration.

The App-owned forecast model filters lifecycle and creation time, excludes past predictions, deduplicates identical rule/time occurrences and keeps that identity across ranges. Absolute times, cron rules and explicitly anchored intervals can be expanded. Floating intervals and delays depend on activation and actual execution: only the enabled rule's known next time is shown, with that coverage explained. Creation time never substitutes for an activation anchor. The model reports invalid triggers and capped predictions. Rule previews are explicitly separate from enabled arrangements. Details retain the clicked time, its predicted meaning and the underlying rule. The displayed timezone is the browser's local timezone; cron expansion still honours each rule's declared timezone.

Manual execution retains the existing backend activation behaviour. Disabled and paused rules label that action Enable and run now. Enabled means the rule can fire, not that a run is in progress; HTTP acceptance is labelled Submitted and results remain in execution history. History shows loaded and total counts, query and refresh recovery. It does not claim a server-side date filter or persistent running-state capability that the existing API does not expose.

This replaces the Agenda-specific mixed list and calendar-card layout in [the feature-page decision](2026-10-01-feature-page-optimization.md). Its shared typography, theme, dialog, Scope submission and recovery decisions remain applicable. The standing presentation rules live in [the Web product specification](../../../../apps/web/PRODUCT.md#feature-pages), and automation semantics remain in [the product documentation](../../../product/automation.md).

## Alternatives considered

**Keep date navigation above the full rule list.** Dates would continue to suggest a filter that does not apply to the displayed object, leaving the central ambiguity intact.

**Retain a meeting-style hourly canvas.** The existing data supplies a trigger point without a planned end time. Allocating artificial time blocks preserves misleading durations and requires widening lanes to keep simultaneous titles readable.

**Combine predicted times and actual runs in one calendar.** Prediction and execution have different evidence and completeness. The existing history API is paged without an exact date filter, so merging them would suggest complete historical coverage.

## Consequences

The page explains what selecting a date changes and keeps rule management available without date controls. Responsive transitions preserve date, view, query and task filters. Each peer destination owns its scroll position: first entry starts at its controls, and returning restores that destination's position rather than inheriting another view's offset. Details preserve list context and return focus through the shared dialog behaviour. Obsolete series expansion, mixed-list presentation and history group animation are removed rather than maintained as a second path.

Forecasts are bounded previews, not promises of execution. Dense rules disclose their limit, and local-time presentation can differ from the timezone used by a cron rule. Cross-refresh live execution state and date-filtered history require separate backend capabilities. No new route, public SDK type or persistence migration is introduced.

Behavioural coverage replaces obsolete series-preview and overlapping-lane assertions with enabled-only predictions, date ranges, clicked occurrence identity, independent history query recovery, trigger intent, readable dense points and same-mount responsive selection. Existing Scope submission, failed-save, dirty-dismissal and nested-overlay tests remain in the browser suite.

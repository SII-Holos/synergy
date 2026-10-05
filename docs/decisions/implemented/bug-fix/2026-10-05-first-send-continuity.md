# Decision Record: Preserve first-send conversation continuity

Status: implemented

## Problem

First-send navigation unmounted the native conversation page when its plugin surface acquired a Session ID and again during storage preparation or draft hydration. A separate simplified preview then handed plain text and filenames to the formal message and process renderers, changing spacing, metadata, attachment order and arrival motion. Canonical message materialization could also remove local content before attachment bodies and authoritative execution state arrived.

## Decision

Render the native default page outside the Session-bound plugin surface; replacement plugin pages preserve their bound-service lifetime. Retain the mounted page while gating canonical history and actions on storage readiness, and retain an inert Composer during transient draft hydration. Restore its retained control's focus only when the user has not selected another control. The existing preparation lease owns the captured local submission, future Session ID, message ID and Part IDs; a host-owned read-only data view presents it through the ordinary conversation renderer. Lease handoff and asynchronous router navigation share one Solid transition, preventing an empty presentation between owners. Ordered plugin preflight remains a barrier before durable creation and input admission. Use canonical Part order in both optimistic summaries and bodies, retain row identity through accepted message aliases, and consume arrival motion only on initial display.

Keep one process trigger through preparation and execution. Matching runtime activity has priority over local receipts. Release the lease once storage and initial connected Scope recovery have settled, the canonical root and complete captured Part bodies have matching cached versions, and authoritative execution evidence is available, including the bounded turn execution query when runtime events arrive late. Complete cached bodies alone cannot release the lease while recovery is pending: recovery can invalidate those bodies immediately after admission. Fill missing canonical Parts from the captured submission until then. After admission, a missing canonical summary page must remain unknown so the ordinary loader can restore snapshot-cleared caches; local content remains visible without a loading spacer. Shared error cards and revision-guarded recovery remain the failure path. This refines the handoff presentation described in [runtime activity](../architecture/2026-10-04-session-runtime-activity.md) without adding a backend status stream or persisted client state.

## Alternatives considered

Styling the separate preview to resemble the timeline would retain two component lifecycles and fail to preserve attachments, controls and scroll anchors. Inserting a fictitious Session into the canonical store would bypass storage readiness and freshness ownership. Delaying all visual feedback until creation or replaying a success transition would preserve the reported interruption. Timer-driven stage changes would misrepresent actual work.

## Consequences

The App owns the transient projection; shared UI accepts an optional typed view and retains attachment rows by identity. Display aliases are bounded and scoped to connection, Scope and Session. User group boundaries, source view and attachment disclosure use that same display identity. The unified resource dispatcher distinguishes captured attachments from canonically admitted resources, preserving temporary preview controls before workbench admission. Historical preparation still blocks canonical content and actions. Browser regressions cover retained message, image, status and viewport nodes for both unchanged and aliased admission identities, alongside storage gating, localization and keyboard recovery.

# Decision Record: Compact task details

Status: implemented

## Problem

Task details mixes task identity, runtime configuration, recording diagnostics, aggregate statistics and queue management. Long paths and persistent actions dominate a small surface, while nested entry gates make queued input harder to find.

## Decision

The compact surface uses flat sections for workspace identity, icon-led metrics, Inbox, scheduled activity and delegated children. Each list has a four-row height limit and independent scrolling; the popup body scrolls on shorter viewports while its header remains visible. Paths and branches use hover/focus disclosure and the workspace name copies its path. Optional controls reserve space and reveal on hover, keyboard focus, an open detail or touch. Full trajectory and removed Inbox history use the workspace options menu.

Task summaries add optional canonical interaction and delegation metadata. Explicit auxiliary sources are filtered only from the compact list, while delegated workflow reviewers and aggregate accounting remain intact. Cancellation uses persisted delegation state and server confirmation rather than invented rollout timings or optimistic terminal status. Independent resources survive statistics failures. Agenda pagination retains accepted rows on refresh failures and rejects outdated requests; Inbox history remains lazy and removal is recoverable.

File recording diagnostics remain internal. Conversation cards, Task details and Review display confirmed files without completeness warnings; unknown evidence does not become a measured zero. Restoration checks and backend evidence remain authoritative.

## Alternatives considered

**Keep configuration and diagnostics in disclosures.** This preserves clutter and promotes internal recording state into ordinary task information; the compact surface omits those controls and notices.

**Truncate child and agenda collections.** This keeps height short but makes retained tasks unreachable. Bounded scrolling and agenda pagination preserve access without expanding the popup.

**Infer auxiliary tasks from titles or hide every unattended child.** User-created names and delegated reviewers can match those heuristics. Explicit canonical source and delegation metadata preserve their identities.

## Consequences

The surface is smaller and queued input becomes directly visible. Paths, aggregate explanations and uncommon actions require hover, focus or a detail interaction. The read model gains additive optional metadata without persistence migration or accounting changes. Internal diagnostics remain available to evidence consumers but have no ordinary file-change UI presentation. Behavioral, update and real browser tests cover metadata, recovery, scrolling, keyboard controls, narrow layouts and independent resource failures. The extracted Agenda renderers preserve the existing Vite/Chromium instrumentation boundary with exact-file entries in the [coverage manifest](../../../../script/coverage-exempt.json); directly testable task filtering and accounting presentation remain measured by Bun.

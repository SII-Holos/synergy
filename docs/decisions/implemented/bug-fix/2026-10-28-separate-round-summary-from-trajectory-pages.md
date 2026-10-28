# Decision Record: Keep round summaries independent of trajectory pages

Status: implemented

## Problem

A selected round summary and a trajectory page can finish independently. Sharing the page's cancellation controller and generation lets pagination cancel a pending summary without replacing it. The selected round can then display whole-session statistics or retain an older summary until another execution event arrives.

A detail revision gap also triggers an early page recovery return. Returning before accepting the event's complete round summary can leave a completed round displayed as running when that event is the final update.

## Decision

The trajectory owner gives scoped summaries their own cancellation controller. Summary requests depend on the selected Session, round, SDK client, transport connection and active-view lifetime. Ordinary page navigation and filters preserve the pending request and accepted summary. Changing the summary's selection clears its value; reconnect and reactivation retain the accepted value while refreshing it. Every completion and error verifies the captured summary owner, including cancellation and disposal.

Complete matching round summaries are accepted before recovering missing trajectory detail. Their canonical revision and clock ordering remain authoritative, while the page independently reaches its required detail revision. This keeps the request sharing and detail recovery behavior in [execution trajectory projection reuse](2026-10-24-reuse-execution-trajectory-projections.md).

## Alternatives considered

**Restart the summary on every page change.** This would recover a cancelled read by issuing another identical request, reintroducing unnecessary work during navigation.

**Accept a cancelled summary without checking its owner.** This would allow an older round or connection to overwrite the current selection. A separate lifetime preserves cancellation and stale-result rejection.

**Wait for the next event after a detail gap.** A terminal event may be the last one. Its complete summary can be accepted even when the accompanying detail delta requires a fresh page.

## Consequences

Pagination does not change summary ownership or add summary reads. One additional controller distinguishes the two asynchronous lifetimes without changing server schemas or persisted data. Deferred transport tests reproduce the pending-summary paging failure and the terminal-gap failure, and verify cancellation and late-result rejection after round changes, reconnects and view inactivity without timing sleeps.

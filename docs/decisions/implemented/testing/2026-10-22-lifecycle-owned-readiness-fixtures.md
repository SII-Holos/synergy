# Decision Record: Keep readiness fixtures within their lifecycle boundaries

Status: implemented

## Problem

Concurrent CI work exposed fixtures that confused elapsed host time with the behavior under test. A responsive WebSocket could miss an 80 ms wall-clock heartbeat budget, cold Docker image preparation consumed a provider-observation timeout, and a minimal Cortex fixture omitted the shutdown registration that owns its retention timers. Deferred startup gauges could also enter a telemetry fault window intended to contain only a condition delta.

## Decision

The healthy heartbeat test advances its logical clock through four real ping/pong exchanges; the silent-tunnel test retains real deadline expiry. Fault-injection observation and the compaction fixture's execution deadline start after the recorded native Agent stage begins, with early-exit detection and their existing deadlines. Preparation retains its own bounded lifecycle. The compaction fixture still cancels and drains its owned CLI on timeout. The Cortex cancellation fixture registers the production Session runtime so closing its Runtime drains task work and clears retention timers.

The telemetry worker-loss fixture force-flushes and acknowledges the startup prefix before suppressing confirmations. A seeded young gauge and explicit aggregation flush exercise the deferred-publication boundary without sleeps; exact uncertain observation counts and both committed and uncommitted database outcomes remain asserted.

The shared LSP startup cancellation fixture submits both independent Workspace queries before native startup and waits for the real server's initialization notification through a scoped protocol observer. The first initialization never auto-completes; the test publishes the replacement process's initialization gate before cancelling its first owner. Native startup and initialization failures preserve their causes, and early query completion fails readiness immediately. A ten-second operation deadline cancels both queries and enters their cleanup before the unchanged fifteen-second framework timeout. The cancellation outcome, successful second query, old-process exit and replacement-process identity remain required. Negative controls reject a missing handshake after draining its process and fail when shared-startup retry is disabled.

Review DOM fixtures scope empty statuses to their comparison or navigation owner. Reading baselines select visible content rather than virtual overscan and retain both viewport containment and selected-line identity alongside the existing displacement limit. Keyboard actions wait for initial popup focus and the previous menu's actual portal exit; moving the pointer into the input dismisses unrelated hover tooltips without adding Escape presses. Virtual navigation waits for the focused target to enter its scroll viewport, since focus can precede the renderer's scroll update. These conditions follow the existing [browser fixture guidance](../../../../.synergy/skill/develop-frontend/references/browser-fixtures.md) without fixed sleeps or longer timeouts.

## Alternatives considered

**Increase every timeout or rerun failures.** This hides lifecycle mistakes and leaves positive heartbeat behavior dependent on runner load.

**Disable cleanup or fault assertions.** Rejected because terminal evidence, cancellation and owned resource removal remain required behavior.

## Consequences

The fixtures retain their existing behavioral assertions and require neither live credentials nor platform-specific data. Docker integration still runs in its CI group; local clock and cancellation tests stay small. Product deadlines and lifecycle semantics are unchanged.

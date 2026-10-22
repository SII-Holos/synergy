# Decision Record: Keep readiness fixtures within their lifecycle boundaries

Status: implemented

## Problem

Concurrent CI work exposed fixtures that confused elapsed host time with the behavior under test. A responsive WebSocket could miss an 80 ms wall-clock heartbeat budget, cold Docker image preparation consumed a provider-observation timeout, and a minimal Cortex fixture omitted the shutdown registration that owns its retention timers.

## Decision

The healthy heartbeat test advances its logical clock through four real ping/pong exchanges; the silent-tunnel test retains real deadline expiry. Fault-injection observation and the compaction fixture's execution deadline start after the recorded native Agent stage begins, with early-exit detection and their existing deadlines. Preparation retains its own bounded lifecycle. The compaction fixture still cancels and drains its owned CLI on timeout. The Cortex cancellation fixture registers the production Session runtime so closing its Runtime drains task work and clears retention timers.

## Alternatives considered

**Increase every timeout or rerun failures.** This hides lifecycle mistakes and leaves positive heartbeat behavior dependent on runner load.

**Disable cleanup or fault assertions.** Rejected because terminal evidence, cancellation and owned resource removal remain required behavior.

## Consequences

The fixtures retain their existing behavioral assertions and require neither live credentials nor platform-specific data. Docker integration still runs in its CI group; local clock and cancellation tests stay small. Product deadlines and lifecycle semantics are unchanged.

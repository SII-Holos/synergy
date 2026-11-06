# Decision Record: Cancel SQLite liveness probes when their driver closes

Status: implemented

## Problem

A busy SQLite worker can still have a liveness monitor running when bounded teardown closes its driver. Probes then resolve immediately without contacting the worker, allowing the monitor to starve the event loop until the recovery ceiling and to report deliberate shutdown as terminal unavailability.

## Decision

The monitor stops when its driver is closed or terminally unavailable. After awaiting the shared monitor, each request checks that the driver remains open and that the request is still pending before interpreting the probe result. Deliberate shutdown retains the existing teardown budget and does not emit a terminal-unavailability notification.

## Alternatives considered

**Keep probing until the recovery ceiling.** The driver has relinquished its worker, so further probes cannot establish recovery and can outlive the host shutdown deadline.

**Add a delay between failed probes.** Yielding avoids event-loop starvation but leaves obsolete monitoring alive after shutdown and permits a false terminal-failure notification.

## Consequences

Normal worker recovery and genuine worker loss retain their existing classification. A real-worker regression begins a blocking SQLite query, waits for busy classification, and verifies bounded close with no terminal-unavailability notification. No persisted format, configuration field, or public API changes.

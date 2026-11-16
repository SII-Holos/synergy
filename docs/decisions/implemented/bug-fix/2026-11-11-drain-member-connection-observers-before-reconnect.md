# Decision Record: Drain member connection observers before reconnect

Status: implemented

## Problem

Resident bridge callbacks received the lifetime of the whole bridge. Losing one socket left its synchronization exporter subscribed and able to enqueue work while the next connection opened. Execution release scans could also finish after stop and create new settlement tasks.

## Decision

Each authenticated connection exposes its own abort signal. The resident bridge creates a callback lifetime for that attempt, aborts it immediately when the connection closes, and awaits the callback's returned cleanup before retrying. Transport cancellation remains independent so an offline connection cannot be relabelled as an intentional bridge shutdown by a feedback abort.

Command receivers may return an asynchronous close owner. Connection drainage awaits received work, the command owner and the resource client once, attempting all cleanup owners even if one fails. The Runtime returns exporter cleanup from its connected callback and release-observer cleanup from its command factory. Release observers track outstanding scans, reject late enqueue after stop, cancel their own waits and drain settlement tasks.

Cleanup failure is terminal and preserves structured errors. Explicit Runtime shutdown awaits cleanup and propagates its failure instead of treating an aborted bridge as proof that cleanup succeeded.

## Alternatives considered

**Keep the bridge-wide signal.** That lifetime intentionally survives transient disconnection and cannot own a per-connection subscription.

**Stop subscriptions without awaiting work.** Already queued scans and writes could race the next connection's state even after event listeners were removed.

**Feed observer abort back into transport cancellation.** This changes an observed offline close into an intentional shutdown and suppresses required reconnect behavior.

## Consequences

Real WSS tests exercise two authenticated connections, old-signal abortion, subscription cleanup before reconnection, absence of stale callback writes, continued heartbeat, asynchronous shutdown drainage and terminal cleanup failure. The [postmortem](../../../postmortem/0099-member-connection-observer-lifetime.md) records the defect and its limits.

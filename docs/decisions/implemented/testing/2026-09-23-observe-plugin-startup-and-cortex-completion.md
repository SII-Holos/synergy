# Decision Record: Observe plugin startup and Cortex completion in tests

Status: implemented

## Problem

The Scope startup disposal test assumes plugin initialization begins within one millisecond, while parent notification tests allow only fifty ten-millisecond polls for Cortex completion. Both assumptions can fail under CI load before the behavior being asserted occurs.

## Decision

The Scope test waits for an explicit signal from its held plugin initializer before requesting disposal and restart. Cleanup releases the initializer and drains all started operations before disposing the Scope. Parent notification tests subscribe to the task completion event, with an immediate state check to cover completion before subscription. The test runner retains its existing deadline.

## Alternatives considered

**Increase sleeps or polling counts.** A larger incidental delay still couples correctness to runner speed. Startup and terminal task publication already provide observable synchronization points.

**Use a foreground Cortex waiter.** Foreground waiters suppress the parent notification that these tests must verify. Observing the completion event preserves notification delivery.

## Consequences

The tests retain startup/disposal ordering, restart counts and persisted notification assertions without imposing a performance budget. The notification observer is scoped to its task and unsubscribed on completion. A missing lifecycle signal fails at the test runner deadline.

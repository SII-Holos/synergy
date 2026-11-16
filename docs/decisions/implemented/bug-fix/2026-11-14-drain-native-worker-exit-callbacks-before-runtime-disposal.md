# Decision Record: Drain native worker exit callbacks before Runtime disposal

Status: implemented

## Problem

Agent and Policy worker hosts treated a known native exit code as completed shutdown. Their original parent callback still needed the owning Runtime. A delayed callback could therefore outlive `stop()` and enter a disposed context.

## Decision

Each existing process host retains the completion of its original exit callback. Every successful stop path waits for both native process settlement and that callback, including the already-exited and forced-stop paths. Callback execution remains inside its captured Runtime. Stopping observes its original error through the same completion promise; callbacks without a stopping observer retain their unhandled failure channel. Pool shutdown and Runtime disposal continue through their original owners.

## Alternatives considered

**Return when the native exit code is known.** Physical exit does not establish completion of parent-side lifecycle work.

**Ignore callbacks after Runtime closure.** That hides unfinished lifecycle work and discards its failures.

**Create another Runtime for late callbacks.** The callback belongs to the original worker and context; a replacement cannot supply its authority or state.

## Consequences

Worker stop retains a finite original callback and propagates its failure before Runtime disposal. Shutdown signals, native exit values, grace periods and protocol validation retain their existing behavior. Real worker tests hold the original callback after actual native exit, verify that stop stays pending, then check one callback in its original Runtime, exact failure propagation and repeated stop. The [incident](../../../postmortem/0203-native-worker-stop-finished-before-its-owned-exit-callback.md) separates this demonstrated boundary defect from the still-unattributed natural Presets failure.

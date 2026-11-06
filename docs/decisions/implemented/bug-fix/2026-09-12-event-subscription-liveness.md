# Decision Record: Couple event subscription removal to WebSocket closure

Status: implemented

## Problem

A global event subscriber can lose its registry entry after a failed send while its WebSocket remains open. Direct pong replies can keep the frontend's connection check healthy despite permanently missing session status and message events. Reconnect and replay cannot repair a connection that never reports failure.

## Decision

The global event registry closes open sockets when removing their subscriptions. Dropped sends and send exceptions remove the registry entry before requesting a retryable close, so reentrant close callbacks cannot remove the same entry twice. Diagnostics include the failure outcome and transport mode without payload contents. Already closed sockets require only registry cleanup; clearing the registry also closes its remaining open subscriptions.

Connected acknowledgements, pong replies, and periodic heartbeats use the registry's reply operation. Replies to unregistered sockets request closure without sending a success frame. Control frames retain the existing tolerance for transient backpressure and do not advance the streaming eviction threshold. WebSocket envelopes, Scope routing, event sequencing, replay, snapshots, and the frontend state model remain unchanged.

## Alternatives considered

**Poll every session status periodically.** Polling would mask lost status events at additional cost while leaving message, inbox, and other event consumers stale. Closing the failed subscription invokes the existing recovery path for every resource.

**Only close after consecutive backpressure.** A zero send result or exception can remove the subscriber before that threshold is reached. Every removal of an open subscription must terminate the connection.

**Reduce pruning bursts first.** Limiting historical part updates could reduce pressure but cannot eliminate transport failures. Subscription recovery must work independently of event volume.

## Consequences

A failed subscriber incurs a reconnect and replay or snapshot refresh instead of retaining indefinitely stale UI state. Healthy subscribers continue receiving events, and control-frame backpressure retains its existing behavior. Unit coverage checks removal, send failures, orphan pings, and reentrant callbacks; a real WebSocket fixture verifies a lost terminal event produces a close and allows idle state to be read after reconnect. The [postmortem](../../../postmortem/0010-event-subscription-liveness.md) records the diagnostic and coverage gap.

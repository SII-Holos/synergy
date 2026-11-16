# Decision Record: Authorize ephemeral organization work notifications

Status: implemented

## Problem

Space-scoped Web components cannot observe work in an inactive organization. Native completion and error references identify the original source, but a Runtime socket or an old human login does not establish current recipient access. Persisting private titles or errors in a separate service inbox would introduce unnecessary content retention and another Session directory.

## Decision

The connected organization Runtime observes the canonical completion and error events through its existing Runtime-scoped Bus. It requires the installed versioned organization reference, an actual root Session and a binding matching that authenticated machine. The observer captures its connection callback and signals and retires them when that connection closes. It sends only an observation ID, kind, Session ID, canonical binding and occurrence time through the existing authenticated machine socket after explicit notification-schema negotiation.

The service checks the machine connection and current Directory binding before offering an observation. Each human subscription independently authenticates its captured login and deployment, then reuses current creator/shared Session and project authorization immediately before delivery. A queued observation from a replaced machine or an older binding is discarded. A changed login, account authorization revision or deployment closes the subscription. The event reference remains provenance rather than permission.

`GET /org/v1/notifications` emits strict metadata-only SSE frames. A ready frame binds a new random stream ID to the exact organization, account, deployment and authorization revision. Notice and heartbeat frames retain that stream ID and contiguous sequence numbers. The decoder rejects changed identities, gaps, invalid UTF-8, truncated frames and oversized input; cancellation is checked before further reads. Individual frames are at most 16 KiB. Separate 64 KiB queue and transport budgets close a slow subscriber without blocking its Runtime or healthy subscribers.

Subscriptions are live observations. Reconnection creates a new stream ID and sequence zero; there is no retained inbox, replay cursor or offline delivery guarantee. Current Session/history interfaces remain authoritative after a disconnect. Service shutdown closes subscriptions before draining active operations. Long-lived response bodies do not retain a maintenance tail; each queued authorization read and its actual enqueue complete inside the same existing service maintenance callback. Releasing that operation cannot leave a separately scheduled authorized write.

## Alternatives considered

**Derive success from idle or a completed message.** Those observations do not establish the canonical native completion notice. Errors remain a separate producer event.

**Deliver using permissions captured when the stream opened.** Project access, sharing, drivers and accounts can change while delivery waits. Both source identity and recipient access must remain current.

**Add a persistent notification feed with copied conversation text.** UI-03 requires source-aware live notifications, not another content store. This implementation retains neither an inbox nor private titles, errors or local paths in the service.

## Consequences

Protocol tests cover fragmentation, coalescing, exact audience, sequence and stream identity, UTF-8 completion and cancellation before or between reads. Service tests use real temporary Storage to exercise private/shared access, held delivery, binding changes, source replacement, project removal, changed account/deployment identity, reconnect and bounded slow consumers. A real enrolled temporary Native Runtime publishes a canonical completion through authenticated WSS and an authenticated HTTPS reader receives its metadata; anonymous and API-token subscriptions are rejected. Native Bus tests cover completion/error sources, absent or unsupported references, children and disposed observers.

This transport does not by itself complete UI-03. Main's typed subscription, retained personal source, canonical Web notification state, exact-space click behavior and final browser acceptance remain separate work. Delivery across an offline interval is explicitly outside this live stream's guarantee.

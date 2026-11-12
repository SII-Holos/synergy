# Decision Record: Retain organization notification sources across space selection

Status: implemented

## Problem

The selected Space view aborts its requests when users navigate. A notification source attached to that view would stop observing an organization whenever another Space opens. Keeping a callback alive without binding its original credentials would instead allow delayed events from an old login or deployment to enter a successor.

## Decision

The existing organization connection owner exposes a notification subscription per complete Space key. Consumers share one physical source for that key. The source captures the exact issuer, client, organization, account, deployment and authorization revision, plus the original in-memory Web credential object or native connection revision. Selecting personal or another account changes business views without changing an independently valid notification source.

Web consumes the generated notification stream through the existing credential-owned fetch path. The strict protocol decoder bounds the raw response before the generated SSE helper buffers it. Native subscriptions use the optional typed notification feature and register their listener before start. The protocol's same receiver validates audience, stream identity and sequence at either entry. Unsupported bridges/endpoints remain unavailable without falling back to a personal route or another credential transport.

Source replacement, expiry, logout and disposal cancel the captured stream and pending retry. Ordinary disconnection retries that original current source with a new stream identity and bounded backoff; it does not replay notices. Authentication failure updates only the affected connection and preserves another selected view. A successful authorization proving a different deployment at the same issuer retires the older descriptions and credentials before their queued responses can be consumed. Metadata edits and stored labels cannot establish that authority change. Other accounts on the same deployment remain independently eligible.

The source multiplexer checks both current connection ownership and each listener's continued membership after any earlier asynchronous listener returns. Removing one consumer preserves the shared stream for the remaining consumers; the last removal cancels it. This map owns subscriptions and callbacks, not credentials, notification history or a Session directory.

## Alternatives considered

**Retain the active Space view.** That would keep UI, drafts and unrelated business requests alive to preserve one event source. Notification transport belongs to the connection owner.

**Create one stream for each notification consumer.** Independent readers would duplicate events and authenticated connections. Consumers share the original verified source instead.

**Treat equal URLs or equal account IDs as the same lifetime.** A deployment replacement or new login can reuse both. Exact identity and the original credential/revision distinguish those lifetimes.

## Consequences

State tests exercise one actual generated Web stream across personal and another-account selection, shared consumers, a held response across fresh login, old-deployment retirement and an unsubscribed listener behind a held predecessor. Native adapter tests retain exact audience across navigation and reject disposed sources or stream gaps. Existing personal completion/error/child resolution and connection/logout tests remain passing. These tests use controlled authentication/transport fixtures and do not claim real inactive App presentation, click-time routing, retained personal SDK ownership or final browser acceptance; those remain the next integration work.

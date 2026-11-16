# Decision Record: Own member Browser connections in Desktop main

Status: implemented

## Problem

Each supervised member has a private local HTTP listener and a separate native Browser registration credential. A native broker that cannot authenticate the HTTP upgrade never reaches registration. Starting a broker separately from its member also leaves no owner for cancellation, failed attachment, restart or shutdown. Concurrent close requests can report completion while native creation or profile writes are still running.

## Decision

The member registry attaches main-owned services after the child becomes locally ready. Attachment receives the private connection once per shared startup. Failed or cancelled attachment drains its returned services and child; restart drains the previous services before replacing them. Shutdown waits for in-flight attachment and every owned service. Renderer status contains only public member metadata.

Desktop main creates one Browser broker and profile-data context registry per account connection. Its existing connection identity includes account, organization, deployment incarnation and issuer, so an equal remote Runtime ID cannot merge native owners. All brokers use the shared native page pool and the existing native namespace mapping. Main supplies theme and saved-data services.

The broker uses the Node-compatible `ws` client to send the local listener bearer only in the HTTP upgrade. The first protocol frame carries only the independent native token. Redirects and compression are disabled, handshake and payload limits remain explicit, and an owned HTTP agent and bounded socket close release transport resources.

Broker close is one shared promise. It immediately revokes profile contexts and socket generation, then waits for dispatched operations, page cleanup, outstanding physical profile writes and socket closure. Disconnect also drains the old generation before reconnecting, without replaying commands.

## Alternatives considered

**Use Node's global WebSocket.** Its browser-shaped constructor cannot supply the member listener's private HTTP header. Moving that credential into a URL or native protocol frame would change the listener's authentication boundary.

**Manage member brokers independently of the registry.** Separate startup and shutdown paths would leave cancelled launches and late attachment results without a reliable cleanup owner. The registry already owns the child's lifecycle and shares startup among callers.

**Use the remote Runtime ID as the native namespace.** Different deployments can issue equal IDs. The main-owned account connection identifies the full local binding.

## Consequences

Actual child-process tests cover shared startup, late cancellation and service shutdown. An Electron fixture exercises Node WebSocket upgrades, real native pages, colliding identities, reconnect without replay and independent member closure. Profile-data writes and pending page creation have explicit close barriers. Organization Browser presentation still requires its own scoped renderer bridge; attaching this native capability does not enable member Session execution.

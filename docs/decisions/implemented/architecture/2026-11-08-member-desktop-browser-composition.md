# Decision Record: Select Browser explicitly for Desktop member processes

Status: implemented

## Problem

A member Home and HTTP listener establish independent Runtime state, but do not select a native Browser backend. Inheriting the personal Desktop environment would share native credentials, while enabling Browser for every member composition would incorrectly offer it to CLI and hosted callers.

## Decision

The private member supervisor request carries an optional Desktop selection with a Browser registration secret. Member opening accepts it only with a loopback listener and a managed Desktop launch entry. The CLI rejects a non-Desktop request before enrollment. The existing Browser component contributes its storage, routes, tools and lifecycle through Agent Runtime; selecting it creates no native page.

The organization adapter declares its Browser component dependency and the package rule permits that single additional owner. It imports the public component entry; the organization service remains independent of Browser and Agent execution.

DesktopServerManager generates independent random HTTP and Browser credentials for every member child attempt. It sends them through private stdin, retains them only in main-owned connection methods, and clears them after shutdown or process exit. The launch profile cannot supply a replacement Desktop credential. The member environment selector continues excluding inherited personal native settings; only validated private request data installs the Browser secret in that Runtime's host environment.

The existing Server requires the HTTP bearer for the WebSocket upgrade. The Browser backend then validates its own first-frame registration secret and rejects browser-originated host connections. No route bypass or additional listener is added. Session execution remains subject to organization command admission.

## Alternatives considered

**Forward the personal Desktop's native environment.** Shared secrets would couple member hosts to the personal Runtime and make a member restart reuse its authority. Explicit launch data permits independent rotation and preserves the environment allowlist.

**Enable Browser for all member listeners.** A local HTTP listener does not establish Desktop ownership. A typed Desktop selection and launch identity keep ordinary CLI members free of native capabilities.

**Exempt the Browser upgrade from local HTTP authentication.** Native registration is a separate proof. Retaining both existing checks avoids expanding the member API's unauthenticated surface.

## Consequences

Member Browser backend composition is available through the ordinary supervised process path, with independent secrets and lazy native allocation. Real sockets verify cross-member rejection and independent teardown; actual CLI and Node-supervisor checks verify startup and restart rather than only parsing options. Main-owned broker lifecycle and renderer presentation must consume the private connection explicitly. Computer, Memory and organization execution authority are not added by this selection.

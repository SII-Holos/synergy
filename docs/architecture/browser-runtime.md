# Browser Runtime

The Browser runtime separates ownership, canonical page state, host control, and presentation. This lets Desktop-local native rendering and remote WebRTC rendering share one session/page contract without introducing tab adapters or screenshot-stream fallbacks.

## Ownership

`BrowserOwner` identifies a Browser context as either:

- session-owned: `<scopeID>:session:<sessionID>`
- scope-owned: `<scopeID>:scope`

Tool execution derives a session owner from the current `Scope` and tool session ID. Routes carry directory, Scope, optional session ID, and ownership mode explicitly. Session ownership requires a session ID.

The server derives the canonical owner key and includes it in every session-state payload. Clients use that value for native presentation leases, event validation, Desktop profiles, and view attachment; route directories are routing inputs and are never alternate owner identities.

## Lazy Runtime and Session State

Chromium and Playwright start lazily when Browser is first used. The process-wide runtime holds one `BrowserSession` per owner. Each Browser session holds zero or one page plus annotations and observers.

Creating or retrieving a Browser session does not create its page. `navigate` is the only ordinary control command that resolves or creates a missing page; commands such as click, read, resize, history, or evaluation require the page to exist.

An active tool-created headless page migrates to the selected Host presentation when the Browser workspace opens. The client issues one `resume` after its passive session read; empty and suspended sessions remain passive. Host readiness is calculated for the current owner and page rather than inferred from global broker availability.

Browser state persists under the Synergy data directory by Scope and owner. It includes page identity and metadata, annotations, storage-state path, and profile directory. A restored saved page keeps its prior page ID and navigates through the user-navigation safety path.

When a session is archived or deleted, the Browser runtime reaper disposes its live session. Runtime shutdown disposes every Browser session and stops the driver.

## Canonical Control Model

`BrowserControl` defines one normalized command/result protocol for navigation, history, viewport, pointer and keyboard input, text insertion, evaluation, CDP operations, downloads, annotations, and related controls.

Canonical session state is the runtime's single page. For an attached host, host state can enrich that record only when it refers to the same page ID; it cannot introduce or merge a second page.

Control requests and state events use separate transports:

- `POST /browser/control` carries commands and returns typed results or retryable host/page states.
- `/browser/events` is a read-only WebSocket for session, page, loading, agent-activity, download, dialog, and host updates.

Sending a command on the events socket is rejected. GET session state and the events socket may ensure the owner session exists, but neither creates a page.

## Native Presentation

For a Desktop-local, same-host client, presentation selection uses the native path. Electron owns a `WebContentsView` attached to the application window and executes the shared command model against its `webContents`.

The native view reports navigation, loading, page state, dialogs, downloads, and lifecycle events back into host control. Its bounds are managed by the Desktop shell; the Web UI remains responsible for the surrounding Browser workspace.

## WebRTC Presentation

Remote presentation uses a Browser host process and two signaling roles:

- the viewer socket belongs to the Web client
- the host socket belongs to the process rendering the page

Signaling only pairs those peers. Media carries the live page and the WebRTC data channel carries normalized pointer, keyboard, text, paste/IME, and CSS viewport input.

Opening signaling without a page returns readiness with no page ID. After the first navigation creates a page, the viewer ensures its Browser host process and waits for host attachment. Host status can be pending, ready, detached, restarting, or failed. Commands that require a ready remote host return a retryable pending response; the latest pending viewport command is coalesced and applied when the host becomes ready.

Navigation is special: it can establish canonical page state before the remote host is ready, then synchronize the attached host. This avoids requiring a pre-existing page merely to start the Browser.

## Network and File Boundaries

Chromium owns webpage network security: same-origin behavior, CORS, TLS, mixed-content checks, Local Network Access, and renderer isolation. Synergy does not maintain a second IP-address policy or classify loopback, private, metadata, benchmark, documentation, or TUN/Fake-IP ranges.

Playwright and Electron traffic use one server-owned HTTP/HTTPS CONNECT gateway. The gateway binds to loopback, indexes random owner-scoped credentials by username, verifies passwords in constant time, issues the standard proxy-authentication challenge, limits concurrent connections, forwards hostnames through the system network stack, and closes all owner sockets on revoke. It is an authenticated transport boundary, not a URL reputation or DNS policy layer.

Browser content sessions grant only Chromium's local-network and loopback-network permissions. Camera, microphone, geolocation, device, filesystem, and unrelated permissions remain denied. Agent navigation still passes through the normal `browser_interact` and `network_request` enforcement capabilities.

Navigation accepts HTTP(S), `about:blank`, and explicit workspace-contained `file:` URLs. File containment resolves real paths and rejects traversal, escaping symlinks, hidden segments, `node_modules`, `.git`, and `.synergy`. Page-initiated file navigation remains blocked. Downloads and network inspection retain their independent filename, MIME, size, and sensitive-header controls.

## Observability and Recovery

Browser routes attach trace IDs, command IDs, owner keys, page IDs, presentation choices, host state, and durations to structured logs. Page loading failure, host pending, signaling failure, page absence, and control failure are separate error states so clients can decide whether to wait, retry, navigate, or report a terminal error.

API errors stay structured through the SDK boundary. WebRTC retries only retryable ticket failures and transient socket closure, resets backoff after Host or media readiness, and discards stale ticket, socket, peer, and timer work when a surface is replaced or disposed.

The interactive surface continues to use live native or WebRTC presentation. Screenshots, DOM snapshots, console entries, network records, and accessibility snapshots are inspection products and tool inputs.

## Invariants

- One owner has at most one canonical Browser page.
- State reads, event subscriptions, and signaling do not create a page.
- The first navigation creates the page; later navigation reuses it.
- Session state is the only source of the canonical owner key.
- Native and WebRTC are peer presentation modes over the same command/state contract.
- Host connection state is not page state and does not create a fallback page.
- The network gateway authenticates and forwards; Chromium owns webpage network policy.
- Workspace resize semantics are CSS width and height across presentations.
- Session archive or deletion releases its live Browser resources.

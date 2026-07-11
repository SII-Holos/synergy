# Browser Runtime

The Browser runtime separates ownership, canonical page state, host control, and presentation. This lets Desktop-local native rendering and remote WebRTC rendering share one session/page contract without introducing tab adapters or screenshot-stream fallbacks.

## Ownership

`BrowserOwner` identifies a Browser context as either:

- session-owned: `<scopeID>:session:<sessionID>`
- scope-owned: `<scopeID>:scope`

Tool execution derives a session owner from the current `Scope` and tool session ID. Routes carry directory, Scope, optional session ID, and ownership mode explicitly. Session ownership requires a session ID.

The owner key is used consistently by runtime maps, persisted state, Desktop profiles, event routing, host control, and frontend connections.

## Lazy Runtime and Session State

Chromium and Playwright start lazily when Browser is first used. The process-wide runtime holds one `BrowserSession` per owner. Each Browser session holds zero or one page plus annotations and observers.

Creating or retrieving a Browser session does not create its page. `navigate` is the only ordinary control command that resolves or creates a missing page; commands such as click, read, resize, history, or evaluation require the page to exist.

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

## Policy Layers

Browser navigation has a hard policy and an agent-authorization layer:

1. hard checks reject invalid protocols, sensitive localhost ports, unsafe files, and workspace escapes
2. agent navigation classifies public or uncommon-localhost access for control-profile approval
3. authorized Browser tools still pass through the normal enforcement gate

User navigation uses the hard check without presenting an agent permission request for ordinary public HTTP(S) pages. A policy override is an explicit command path, not an implicit fallback.

File containment resolves real paths where possible and blocks dotfiles plus `node_modules`, `.git`, and `.synergy` path segments. Download and network inspection apply separate MIME, extension, and sensitive-header filters.

## Observability and Recovery

Browser routes attach trace IDs, command IDs, owner keys, page IDs, presentation choices, host state, and durations to structured logs. Page loading failure, host pending, signaling failure, page absence, and control failure are separate error states so clients can decide whether to wait, retry, navigate, or report a terminal error.

The interactive surface continues to use live native or WebRTC presentation. Screenshots, DOM snapshots, console entries, network records, and accessibility snapshots are inspection products and tool inputs.

## Invariants

- One owner has at most one canonical Browser page.
- State reads, event subscriptions, and signaling do not create a page.
- The first navigation creates the page; later navigation reuses it.
- Native and WebRTC are peer presentation modes over the same command/state contract.
- Host connection state is not page state and does not create a fallback page.
- Workspace resize semantics are CSS width and height across presentations.
- Session archive or deletion releases its live Browser resources.

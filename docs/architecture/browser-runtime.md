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

Browser execution belongs to the Control Plane/tool-runtime layer, not the Agent worker. The model receives only the serializable Browser tool definitions. Browser callbacks, canonical sessions, Playwright, Chromium discovery, host signaling, native views, and WebRTC state must not enter the Agent worker runner's static dependency graph. A proposed Browser call is authorized and scheduled only after the provider turn has released its Agent worker.

Desktop-native and downloaded remote Browser Hosts run on Electron's packaged Chromium. Direct headless Browser tools in the standalone runtime discover Chrome or Chromium from `CHROMIUM_PATH`, Synergy-managed installation, Playwright caches, or standard system installation paths. Packaged standalone runtimes carry their pinned Playwright Core module as a filesystem-backed sidecar resolved relative to the executable; they never depend on a build checkout or package-manager cache.

`synergy browser install` downloads a Chromium archive bound to the current release by an Ed25519-signed manifest, then verifies its target, size, digest, and executable before an atomic install. On Linux it also ensures the distribution dependencies declared by that pinned Playwright version, unless the caller uses `--no-deps`; `browser install-deps` reruns only that system-package step. `synergy browser doctor` checks the same discovery and launch path used by Browser tools and reports Linux loader diagnostics with the matching recovery command.

Creating or retrieving a Browser session does not create its page. `navigate` is the only ordinary control command that resolves or creates a missing page; commands such as click, read, resize, history, or evaluation require the page to exist.

An active tool-created headless page migrates to the selected Host presentation when the Browser workspace opens. The client issues one `resume` after its passive session read; empty and suspended sessions remain passive. Host readiness is calculated for the current owner and page rather than inferred from global broker availability.

Browser state persists under the Synergy data directory by Scope and owner. It includes page identity and metadata, annotations, storage-state path, and profile directory. A restored saved page keeps its prior page ID and navigates through the user-navigation safety path.

Session-owned headless pages suspend in place after ten minutes without a Browser command. The command service owns the inactivity deadline and serializes suspension with the owner's command queue; accepting a newer command invalidates stale timer work. Scope-owned pages and Host-backed pages are excluded because native and WebRTC activity does not pass through that command-idle signal. Suspension closes the live headless page and owner context while retaining the canonical `BrowserSession`, descriptor, checkpoint, annotations, downloads, gateway, broker state, and `BrowserEvent` subscribers. A later `resume` recreates the same page identity and existing event subscribers observe the `page.closed` and `page.created` transition. Cleanup failures retain their resource handle and retry at most three times after the initial attempt; new command activity resets that retry budget.

When a session is archived or deleted, or a Cortex child session reaches a terminal task status, the Browser runtime reaper disposes its live session. Disposal closes the live page and owner context while preserving suspended Browser state for later restoration. Runtime shutdown disposes every Browser session and stops the driver.

Browser resource attribution counts owners and pages by backend without exposing owner identifiers. The remote Browser Host is eligible for idle retirement only after the broker reports that no canonical page is active for any owner; an active page cancels the retirement timer. Performance may report Host RSS and the idle-retirement effect, but it cannot close Browser pages or stop the Host directly. Headless Chromium remains explicitly partial when its process RSS is not available through the driver contract.

The shared Playwright browser retires only when no owner contexts are live or being created. Retirement and relaunch are serialized, and a failed Chromium close retains the browser handle so a later owner release, ensure, or runtime stop can retry cleanup instead of losing track of a live process.

## Canonical Control Model

`BrowserControl` defines one normalized command/result protocol for navigation, history, viewport, pointer and keyboard input, text insertion, evaluation, CDP operations, downloads, annotations, and related controls.

Canonical session state is the runtime's single page. For an attached host, host state can enrich that record only when it refers to the same page ID; it cannot introduce or merge a second page.

Control requests and state events use separate transports:

- `POST /browser/control` carries commands and returns typed results or retryable host/page states.
- `/browser/events` is a read-only WebSocket for session, page, loading, agent-activity, download, dialog, and host updates.

Sending a command on the events socket is rejected. GET session state and the events socket may ensure the owner session exists, but neither creates a page.

## Native Presentation

For a managed Desktop-local, same-host client, presentation selection requires the native path. The Desktop renderer first asks the main process whether the current server origin belongs to its registered Browser Host. Its passive session read obtains the canonical owner key without mounting the response's temporary presentation; subsequent event and control requests use fresh, one-shot, owner-bound native tickets and explicitly request `native`. Missing, expired, replayed, wrong-owner, wrong-origin, or Host-pending tickets are structured retryable errors. They never select WebRTC. Web clients and Desktop clients connected to a remote server explicitly select WebRTC as their intended mode.

Desktop ticket coordination serializes capability checks and ticket issuance. It retries Host registration at 250 ms, 500 ms, 1 second, 2 seconds, and then 5-second intervals. After 30 seconds the UI presents a failed native recovery state while continuing low-frequency 30-second retries; Retry restarts the fast window. A broker may sign tickets only after the server acknowledges `host.registered`. Managed-server restart and origin changes close the old broker, clear its origin, and bind the new server before the renderer resumes Browser presentation.

Electron owns a `WebContentsView` attached to the application window and executes the shared command model against its `webContents`.

The native view reports navigation, loading, page state, dialogs, downloads, and lifecycle events back into host control. Its bounds are managed by the Desktop shell; the Web UI remains responsible for the surrounding Browser workspace. Shared viewport commands can change the view's CSS width and height, but they preserve the presentation origin assigned by the shell.

Native pages start with a real 1280×720 CSS viewport before attachment so navigation checkpoints and tool commands never observe a zero-sized document. When a Host page is created or a headless page migrates to Host, the server publishes page-scoped readiness after the canonical page event. An already-open workspace can then attach the live `WebContentsView` immediately; attachment and resize ignore zero-sized layout frames and surface IPC failures as structured Browser errors.

Desktop-native presentation becomes temporarily invisible while a blocking DOM dialog, file chooser, or page dialog is open. The `WebContentsView` remains attached and its page, bounds, event subscriptions, and tool activity stay live; presentation is restored when the final blocker closes.

A native page is a stable owner/page slot whose internal `WebContentsView`, CDP control, and diagnostics generation can be replaced. Renderer exit, unexpected destruction, a sustained five-second unresponsive state with a failed CDP liveness probe, or a CDP command timeout starts one page-scoped recovery flight. A healthy but temporarily unresponsive renderer stops its current load and reloads; an unhealthy renderer runs at most three recovery rounds, with each round rebuilding its generation up to three times at 0 ms, 500 ms, and 2-second delays. Three consecutive failed rounds enter the explicit-retry state. Every automatic recovery action — renderer rebuilds, healthy-path reloads, and navigation watchdogs — consumes one shared per-page budget (default five); when the budget is exhausted the slot enters the explicit-retry state and only a manual Retry resets it. A live CDP probe does not prove the main thread is healthy, so a wedged renderer that answers probes is still bounded by the budget instead of reloading forever. The navigation watchdog retry counter resets only when a navigation completes or fails terminally, so mid-navigation redirects cannot silently reset it into an unbounded reload loop. Replacement retains the canonical page ID, persistent partition/profile and login state, proxy grant, last URL, bounds, visibility, and focus; closing the replaced generation is best-effort so a wedged old renderer never rolls back a recovery that already succeeded. Renderer-local uncommitted DOM and form memory cannot be retained.

`resume` is the idempotent recovery entry for an existing owner/page. On a healthy native page it returns page state without replacing the generation; during a recovery flight it waits for that flight; after a failed native recovery it starts a new bounded flight and resets only the transient recovery budget. `BrowserHostPage` and the native pool reject side-effect commands during `restarting` or `failed` with `browser_native_restarting` or `browser_native_recovery_failed`, while `resume`, `close`, and safe observations (snapshot, read, inspect, screenshot, diagnostic reads, audit, dialog status, clipboard read, and checkpoint capture) remain available. `ready` is emitted only after the recovery guard clears. A command whose execution outcome is unknown is never replayed automatically, and failed recovery does not expose a WebRTC switch.

## WebRTC Presentation

Remote presentation uses a Browser host process and two signaling roles:

- the viewer socket belongs to the Web client
- the host socket belongs to the process rendering the page

Signaling only pairs those peers. Media carries the live page and the WebRTC data channel carries normalized pointer, keyboard, text, paste/IME, and CSS viewport input.

During page creation, the broker reservation and its one-shot Host ticket form a creation lease. The Host signaling socket may attach under that lease before the new page is committed as canonical session state. Viewer signaling still requires the committed active page, so pending Host construction cannot expose an uncommitted page to a Web client.

Viewer signaling requires an Origin header. HTTP(S) viewers are accepted only when their Origin matches the backend request, both sides are loopback peers, or the Origin appears in the server-authorized viewer allowlist. Explicit server CORS origins populate that allowlist; the startup-snapshotted `SYNERGY_ALLOWED_ORIGINS` environment variable remains a compatibility source. Automatically detected LAN CORS origins and proxy forwarding headers do not authorize Browser viewer sockets. The Origin check supplements, but never replaces, the one-shot owner/page/role-bound viewer ticket.

The Electron Host controller runs from a generated local file, so its WebSocket handshake may carry the exact `file://` Origin. Host signaling permits that local-file Origin or no Origin, rejects HTTP(S) page Origins, and always requires the one-shot owner/page/role-bound ticket.

The registered socket from signaling `onOpen` remains the peer identity for later message and close events; transport adapters may expose a different wrapper object to each callback. Relaying against a callback-local wrapper would incorrectly discard valid viewer offers as stale.

The trusted Electron main process starts the controller's display capture with a simulated user gesture before page creation reports ready. Only the controller may receive Electron's `media` or `display-capture` permission. Capture startup is bounded; failure to acquire the canonical page frame fails page creation instead of leaving the viewer indefinitely negotiating without a Host answer.

Opening signaling without a page returns readiness with no page ID. After the first navigation creates a page, the viewer ensures its Browser host process and waits for host attachment. Host status can be pending, ready, detached, restarting, or failed. Commands that require a ready remote host return a retryable pending response; the latest pending viewport command is coalesced and applied when the host becomes ready.

Navigation is special: it can establish canonical page state before the remote host is ready, then synchronize the attached host. This avoids requiring a pre-existing page merely to start the Browser.

The Host process calls back to the server's own listen address, never the client request origin. At listen time the server registers its URL with the Host broker process; wildcard binds are rewritten for loopback (`0.0.0.0` to `127.0.0.1`, `::` to `[::1]`). `SYNERGY_BROWSER_HOST_SERVER_URL` overrides that resolution explicitly. Host launches are serialized and run in the background so a control request never blocks on a multi-minute install. A control request waits at most 5 seconds for registration; if the Host is still installing or starting it receives a retryable `browser_host_pending` and the client retries in the background with a status-aware budget (120 seconds installing, 30 seconds starting). A failed or unavailable Host rejects immediately. If the resolved callback URL changes while a Host process is alive, the server restarts that process with the new URL instead of failing.

## Network and File Boundaries

Chromium owns webpage network security: same-origin behavior, CORS, TLS, mixed-content checks, Local Network Access, and renderer isolation. Synergy does not maintain a second IP-address policy or classify loopback, private, metadata, benchmark, documentation, or TUN/Fake-IP ranges.

Playwright and Electron traffic use one server-owned HTTP/HTTPS CONNECT gateway. The gateway binds to loopback, indexes random owner-scoped credentials by username, verifies passwords in constant time, issues the standard proxy-authentication challenge, limits concurrent connections, forwards hostnames through the system network stack, and closes all owner sockets on revoke. HTTPS CONNECT establishment is bounded to 30 seconds; after connection it uses the existing 30-minute tunnel idle timeout. It is an authenticated transport boundary, not a URL reputation or DNS policy layer.

Browser content sessions grant only Chromium's local-network and loopback-network permissions. Camera, microphone, geolocation, device, filesystem, and unrelated permissions remain denied. Agent navigation still passes through the normal `browser_interact` and `network_request` enforcement capabilities.

Navigation accepts HTTP(S), `about:blank`, and explicit workspace-contained `file:` URLs. File containment resolves real paths and rejects traversal, escaping symlinks, hidden segments, `node_modules`, `.git`, and `.synergy`. Page-initiated file navigation remains blocked. Downloads and network inspection retain their independent filename, MIME, size, and sensitive-header controls.

## Observability and Recovery

Browser observability uses the canonical `ObservabilityEvents`, `ObservabilityMetrics`, `ObservabilitySpans`, `ObservabilityStore`, context, and redaction paths. Generic HTTP middleware records redacted route logs and `http.request` spans and size metrics with correlation, trace, and request IDs; `POST /performance/browser-metrics` validates and redacts frontend batches before storing them in `obs_browser_batches`. The Browser control route accepts an optional trace ID. These paths provide bounded, redacted observability substrate; they do not by themselves establish Browser command/recovery metric coverage or production SLO baselines.

Native ticket and recovery logs expose only error code, lifecycle stage, duration, and boolean match results. They do not include tickets, registration secrets, owner/session identifiers, or URL values. A native main-document load has a 30-second watchdog: it stops loading and probes renderer liveness, retries the navigation once when the renderer is healthy, rebuilds an unhealthy renderer, and reports an explicit page error after a second healthy-renderer network timeout. Loading events fired mid-navigation (including redirects) do not reset the retry counter, and the counter is bounded by the shared recovery budget, so a redirect or timeout loop cannot reload the page forever. Ordinary HTTP status, `did-fail-load`, and individual resource failures do not rebuild the renderer.

API errors stay structured through the SDK boundary. WebRTC viewer signaling retries retryable ticket failures and transient socket closure, resets backoff after Host or media readiness, and discards stale ticket, socket, peer, and timer work when a surface is replaced or disposed. If only the Host signaling socket disconnects while the broker-owned page remains alive, the server reports that WebRTC presentation as detached, issues a fresh one-shot Host ticket through the broker, and the Electron controller replaces its signaling socket without recreating the canonical page or losing page state.

Viewer ticket retries also heal an initially missing Host signaling attachment: when the canonical page still belongs to the broker but no Host socket is attached, issuing a viewer ticket renews the one-shot Host ticket through the broker. An already attached Host is left unchanged.

The interactive surface continues to use live native or WebRTC presentation. Screenshots, DOM snapshots, console entries, network records, and accessibility snapshots are inspection products and tool inputs.

Browser page close is asynchronous and idempotent. Desktop detaches diagnostics and CDP control, waits for Electron destruction, clears owner maps and tickets, and only then acknowledges logical closure. A subsequent navigation creates a fresh page for the same owner; cleanup errors cannot leave an active descriptor pointing at destroyed `webContents`.

Tool actions keep failures atomic and results directly useful to the agent. Before dispatch, the target must be actionable (visible, stable, enabled); agent navigation defaults to the main-frame `load` settle with a 15-second timeout, settle-eligible actions default to `networkquiet` with a 10-second timeout, and both use a 30-second hard cap with a 500ms quiet window. User navigation remains immediate; explicit settle options are honored. A timeout is non-fatal: the result reports `settled: false`, settle reason, elapsed time, inflight count, current page state, and a best-effort accessibility snapshot capped at 500 nodes when readable.

Tool results distinguish dispatch, settling, and observation from business completion. `browser_action` reports that input was dispatched, its settle outcome, and observed page or snapshot data; `settled: false` is not an action failure. `browser_navigation current` reports session/page status, loading, URL/title, and the last error with a suggested next step without creating a page. `browser_wait` reports an observed condition, not proof that a business effect completed. When a command result is unknown, tool guidance says not to re-execute the same call; verify with a fresh observation and a new command ID.

Strict locators never select the first of multiple matches. `browser_locator_ambiguous` returns a bounded, redacted candidate list (at most five) with tag, role/name, id/class, visibility, bounds, frame, and event-receiving state; candidates that resolve to a backend node also receive a `snapshotId`/`ref` for a follow-up locator. The error recommends exact matching or a stable scope rather than retrying the ambiguous side effect.

`browser_screenshot` persists each PNG as a Synergy asset. When the active model accepts image input, the tool also supplies the PNG directly as a provider-file model attachment. For text-only models, it returns the real local asset path. The output directs the agent to use `look_at` when the configured `vision_model` is image-capable, or reports only the saved local path otherwise. Screenshot inspection does not depend on guessed session paths or an unavailable image tool.

## Invariants

- One owner has at most one canonical Browser page.
- State reads, event subscriptions, and signaling do not create a page.
- The first navigation creates the page; later navigation reuses it.
- Session state is the only source of the canonical owner key.
- Native and WebRTC are peer presentation modes over the same command/state contract.
- Managed-local Desktop requires native presentation and never falls back, automatically or manually, to WebRTC.
- Web and remote Desktop explicitly use WebRTC; this is a mode selection rather than a native failure fallback.
- Host connection state is not page state and does not create a fallback page.
- The network gateway authenticates and forwards; Chromium owns webpage network policy.
- Workspace resize semantics are CSS width and height across presentations.
- Session archive or deletion, and terminal Cortex child status, release live Browser resources while preserving restorable state.
- Command inactivity suspends only session-owned headless pages; it never removes the canonical session or its event subscribers.
- Recoverable idle suspension and terminal owner disposal remain distinct lifecycle transitions.
- Browser implementations and runtime state never load through the Agent worker runner dependency graph.

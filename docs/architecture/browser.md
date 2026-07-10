# Browser Architecture

Synergy Browser is a single-page, owner-isolated browser runtime shared by the Web workspace, Desktop workspace, and agent tools. `packages/browser` owns Protocol v2, structured locators, the CDP page controller, navigation actionability, errors, redaction, and file-name safety. `packages/synergy/src/browser` owns sessions, persistence, policy, the network gateway, Host brokering, signaling, and runtime lifecycle. `packages/desktop` supplies Electron native and WebRTC presentation backends.

## Page ownership and lifecycle

Each `BrowserOwner` has at most one page. Owner keys use an unambiguous shared encoding; persisted directories use a SHA-256 owner identifier so client-controlled session identifiers cannot traverse paths or collide after sanitization.

The session state machine is:

- `empty`: no descriptor and no live page.
- `suspended`: a backend-neutral descriptor and checkpoint exist, but no page is running.
- `active`: exactly one headless or Host page is live.
- `migrating`: the source page has closed and the target page is not yet committed.
- `failed`: recovery metadata and a structured failure remain available.

State reads are passive. `GET /browser/session`, the events WebSocket, and WebRTC signaling never create, resume, or navigate a page. A user control navigation, user resume, or agent command that requires a page performs lazy activation. Restarted sessions load as `suspended`.

Commands for one owner run through a serial queue. Every command has a `commandId`; replaying the same id and payload returns the cached result or error, while reusing it for a different payload returns `browser_command_id_conflict`. Aborts stop eligible in-flight loading and waits without letting the next queued command overtake them.

Backend choice is fixed when a page is created. Interactive Browser controls use a registered Host: local Desktop uses `native`, while Web and remote Desktop use `webrtc`. Tool-only environments without a Host use Playwright headless. Switching an active page captures URL, cookies, current-origin storage, form values, viewport, and scroll; closes and verifies the source page; then restores the target. A failed target is closed before the source backend is restored.

## Protocol and controller

All Browser boundaries use `BROWSER_PROTOCOL_VERSION = 2` and strict Zod unions for session state, controls, backend commands/results, Host lifecycle, events, WebRTC signaling, input, and structured errors. Browser events carry owner-local `seq` and `epoch` values and use the normal replay/watermark model. Media stays on WebRTC and is not serialized into events.

`CdpPageController` depends only on `CdpTransport`. Playwright supplies a `CDPSession`; Electron supplies `webContents.debugger`. Both therefore share navigation, snapshot refs, locators, actionability, input, waits, read/inspect, screenshots, evaluation, console/network capture, performance tracing, audits, emulation, clipboard, uploads, and checkpoints.

Locators are structured values: snapshot ref, test id, role/name, label, placeholder, text, standard CSS, or XPath, with optional `within` and `framePath` on semantic selectors. Snapshot refs bind to a document generation, frame, and backend node. They never fall back to DOM order. Standard CSS is validated before action; Playwright-only selectors such as `:has-text()` fail immediately with `browser_invalid_selector` and a semantic-locator suggestion.

Element actions require one match and check visibility, stability, enabled/editable state, and event reception. Obstruction fails within the action timeout (five seconds by default) with a bounded `obstruction` summary. Playwright call logs and backend stacks do not cross the protocol boundary.

`browser_eval` has two modes. `readonly` uses an isolated realm and CDP side-effect rejection and fails closed when the realm is unavailable. `trusted` permits mutation and is protected by its own high-risk capability.

## Tool surface and permissions

The Browser tool surface is intentionally non-overlapping:

- `browser_navigation`, `browser_snapshot`, `browser_action`, `browser_wait`, `browser_read`, `browser_inspect`, `browser_screenshot`
- `browser_eval`, `browser_console`, `browser_network`, `browser_performance`, `browser_audit`, `browser_emulate`
- `browser_dialog`, `browser_upload`, `browser_downloads`, `browser_clipboard`, `browser_assets`, `browser_annotate`, `browser_view`

Tool outputs and collections are bounded or paginated. Screenshots are stored as Synergy assets. Downloads first enter owner-isolated managed storage. Uploads read permission-reviewed workspace files without following symlinks, transfer content rather than client paths, and retain bounded staging leases long enough for form submission.

Capabilities distinguish Browser inspection, interaction, coordinates, readonly/trusted evaluation, clipboard, upload, downloads, private network, and emulation. Upload also requires file read. Download, asset, and trace exports also require destination write permission. `guarded` may ask, `autonomous` denies operations it cannot pre-authorize, and `full_access` silently permits capability checks.

## Host and presentation

One Browser Host broker serves a server and multiplexes owner pages. It never launches one Desktop process per page. The Desktop main process is the native broker for its local server. Web mode runs the minimal `browser-host-main` entry once and reuses it across sessions. Closing a workspace detaches presentation; it does not close a page still owned by tools.

The server creates a 256-bit registration secret. Native presentation leases and Host/viewer signaling tickets are short-lived, owner/page/role-bound, and single-use. Host messages are versioned, size-limited, rate-limited, page-bound, and role-checked. WebRTC signaling uses connection ids, offer generations, and ordered ICE sequences so stale viewers cannot reclaim a connection. Only display video is captured; page audio, camera, microphone, location, notifications, and clipboard permissions are denied by default.

The Browser workspace has no screenshot-stream fallback. Native presentation attaches the existing `WebContentsView`. Remote presentation sends display video over WebRTC and pointer, wheel, key, text/IME, paste, and resize input over a data channel. Opening an empty workspace remains passive. The first interactive navigation lazily starts or installs a WebRTC Host if one is not registered yet.

## Network and files

Playwright and Electron traffic use the server-owned HTTP/HTTPS CONNECT gateway. The gateway authenticates each owner, resolves DNS itself, validates every returned address, and connects to the validated IP to prevent DNS rebinding. Cloud metadata, link-local, multicast, documentation/reserved ranges, and unsafe localhost ports are always denied. Private networks require `browser_private_network`; only the controlled development-port allowlist is available on localhost without it. Redirects and subresources create new proxy requests and are checked again.

Top-level navigation also passes `BrowserNavigationPolicy`. User and agent commands are distinct, cross-origin page navigation needs a current direct grant or a bounded real user gesture, `file://` is unsupported, and popups are denied or policy-checked before reusing the current page.

Persistent state, profiles, staging, and downloads use owner hashes, mode `0700` directories, `0600` files, strict schemas, atomic replacement, symlink checks, and containment checks. Browser logs and tool results redact credentials, authorization/cookie headers, secret query values, clipboard contents, and upload contents by default.

## Development and release modes

- `bun dev web`: server, Vite, and one minimal WebRTC Browser Host daemon. The Host entry builds once at startup.
- `bun dev desktop`: server, Vite, and the Electron shell registered as the local native broker.
- `bun dev desktop --managed`: the Web app is built first; Electron starts the packaged-style server and registers the same native broker.
- Desktop attached to a remote server has no shared registration secret and uses the remote WebRTC Host.

Opening a viewer or developer panel performs no build. Browser developer panels are dynamically loaded.

Product releases publish `synergy-browser-host-{platform}-{arch}-{version}.zip` plus a manifest and `.sig` for every supported platform/architecture. The manifest includes the exact Synergy version, Protocol v2, SHA-256, byte size, URL, and executable path and is signed with Ed25519. Runtime installation requires an embedded public key, an exact version/protocol match, a valid signature and digest, and safe atomic extraction under `Global.Path.data/browser/host`.

## Verification

The shared controller contract runs against real Playwright CDP, and the Electron runtime smoke drives the same protocol through the minimal Host. Browser tests cover passive state reads, lazy restore, one-page concurrency, command replay, migration rollback, selector/actionability errors, permission profiles, network address policy, owner isolation, signaling replay, Host authentication, artifact tampering, and process reuse. The three development planners assert WebRTC, native, managed, and remote-Desktop ownership rules.

# Browser Workspace

Browser is a shared workspace between the user and the active Synergy session. The user can navigate and interact visually while agents inspect and operate the same page through Browser tools.

The default owner is a session. Each session owns at most one Browser page, so the address bar, rendered surface, model tools, annotations, downloads, and diagnostics refer to one coherent browsing context. A scope-owned mode exists for explicitly shared integrations, but normal product use is session-owned.

## One Session, One Page

Opening the Browser panel, reading Browser session state, connecting the event socket, or opening WebRTC signaling does not create a page. The first user or agent navigation creates it. Later navigation reuses that page.

There is no Browser tab strip or hidden collection of pages to merge. Closing the page returns the session to its no-page state. Archiving or deleting the owning Synergy session disposes its live Browser page so Chromium renderers do not accumulate.

Page identity, URL, title, recent activity, annotations, profile directory, and browser storage state are persisted by owner. Restoring a Browser session recreates its single page and attempts to return to the saved URL.

## User and Agent Interaction

The user surface provides an address bar, back/forward/reload/stop controls, fit and fixed viewport choices, direct pointer and keyboard interaction, annotations, and Browser-focused diagnostic panels.

Agents operate the same page with tools for:

- navigation, history, viewport, clicking, typing, scrolling, and composite actions
- accessibility snapshots and page reads
- screenshots and element inspection
- console and network inspection
- waiting for page or element conditions
- controlled evaluation
- assets, clipboard, downloads, and Browser health

User annotations retain the page, target reference or element, comment, optional style feedback, resolution state, and time. They can be formatted into agent context so visual feedback remains attached to the page work rather than being copied into an unrelated note.

## Presentation Modes

The Browser workspace has two first-class interactive presentations:

- Desktop-local native presentation embeds Electron `WebContentsView` in the application window.
- Remote Web presentation streams the Browser host with WebRTC and sends input over its data channel.

Both represent the same session-owned page and command model. Remote presentation preserves normal browser interaction: pointer focus, wheel input, keyboard shortcuts, text caret behavior, paste, and IME composition. Host `pending`, `ready`, `restarting`, and loading states describe connection progress; a temporarily pending host is not treated as a fatal page error.

Interactive Browser presentation is not an iframe, pseudo-tab, or screenshot-stream fallback. Screenshots remain deliberate artifacts for inspection and agent tools, not the transport for interactive browsing.

## Navigation and Network

User address-bar navigation and agent navigation use the same Chromium-backed page. HTTP and HTTPS targets follow the machine's normal network routing, including localhost, private development services, direct IP addresses, and TUN/Fake-IP environments. Agent calls remain governed by the ordinary Browser interaction and network-request capabilities; Browser does not add a second private-network permission.

Chromium owns webpage-origin security, CORS, TLS, mixed content, and Local Network Access. The Synergy gateway is owner-authenticated transport plumbing and must not reinterpret routable IP ranges. Browser content grants Chromium local-network and loopback-network access without granting unrelated device, location, media, or filesystem permissions.

`file:` navigation is limited to an existing path inside the active workspace. Dotfiles and paths containing `node_modules`, `.git`, or `.synergy` are denied, including after symlink resolution. Other protocols are denied except the internal blank page used for an empty Browser.

Downloads are checked by MIME type and filename. Text, images, JSON, PDF, and common archive formats are eligible; executables, scripts, installers, opaque binaries, and other dangerous extensions are blocked. Network inspection strips sensitive headers such as cookies and authorization values.

## Viewports

Workspace resize commands use CSS viewport width and height. Fit mode follows the available panel; fixed mode uses a selected viewport. Device scale details belong to the underlying browser implementation and are not part of the shared user-facing resize contract.

## Boundaries

- Browser is a workspace attached to a Synergy owner, not an independent conversation.
- User and agent interaction converge on one page state.
- Presentation mode changes how the page is shown, not what page the session owns.
- Browser policy supplements the centralized control profile; it does not replace tool authorization.
- A Browser screenshot is an artifact, not an interactive presentation mode.

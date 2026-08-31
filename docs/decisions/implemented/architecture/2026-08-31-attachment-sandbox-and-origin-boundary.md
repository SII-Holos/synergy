# Decision Record: Sandbox script-capable attachments and gate the global event stream by Origin

Status: implemented

## Problem

Interactive HTML attachments (e.g. Archify-generated diagrams) rendered blank in the attachment workbench: the preview strips all `<script>` tags (DOMPurify) and renders into a sandboxed iframe with `script-src 'none'`, so script-driven documents silently degraded to half-broken pages with no way to view them as intended. The fix (PR #1289) added an "Open in your browser" action that loads the asset URL directly, which exposed two gaps:

- Script-capable attachments served from `/asset/<id>` ran with **full server same-origin authority**: app localStorage, the unauthenticated HTTP control plane, and the Desktop preload bridge. The new action made this reachable from the workbench toolbar for every attachment.
- The global event WebSocket (`/global/event/ws`) has **no Origin check** and is not covered by CORS, so any same-origin script — including one inside a script-capable attachment opened in a new tab — could subscribe and exfiltrate the full session event stream (message content, tool results).

## Decision

- `/asset/<id>` returns `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals` for **both** `text/html` and `image/svg+xml`. The sandbox directive puts the document in an opaque origin, so its scripts still run (interactive documents keep working) but lose all same-origin authority over the app: no app localStorage, no unauthenticated HTTP control plane, no event WebSocket, no Desktop preload bridge. SVG is included because the workbench can open it as a top-level document where its scripts would otherwise execute same-origin; `<img>`/CSS consumption of SVG is unaffected by the header.
- `/global/event/ws` accepts only clients whose `Origin` matches the server's own origin (the Synergy SPA on web and Desktop) or a loopback peer. Opaque origins (`Origin: null`, including sandboxed attachment pages), missing origins, and cross-origin pages are rejected with close code 1008. The check lives in `Server.globalEventOriginAllowed` as a pure, tested function.
- Web `platform.openLink` (`window.open`) passes `noopener,noreferrer` so a sandboxed page with `allow-scripts` cannot navigate the opener tab to a phishing page. Desktop `shell.openExternal` is unaffected.

## Alternatives considered

- **Sandbox only `text/html`, excluding SVG (PR #1289 as submitted)** — rejected: the workbench toolbar's open-in-browser action is offered for every attachment, and an SVG opened as a top-level document receives the global SPA baseline CSP with `script-src 'unsafe-inline'`, executing scripts with full same-origin privilege. The "SVG is only consumed via `<img>`" premise no longer held once top-level opening was added.
- **Authenticate the event WebSocket with a token** — rejected: Origin checking already closes the cross-origin and opaque-origin exfiltration paths without changing the client or introducing token lifecycle; the SPA and Desktop both connect from the server's own origin, and loopback-to-loopback covers LAN/dev hosts. A token would be a larger contract change with no additional coverage of the same attack.
- **Restrict script-capable assets to `attachment` download only** — rejected: the feature's purpose is to let users view interactive documents as intended; sandboxing preserves that while removing the trust boundary violation.

## Consequences

Attachment content (HTML and SVG) is now untrusted at the HTTP layer: scripts execute only inside an opaque origin with no access to app state, the control plane, or the event stream. The global event stream is only readable by same-origin or loopback clients; operators who legitimately connect from a different origin must extend the CORS/WS allowlist (`cors` listen option), which already feeds `configureBrowserViewerOrigins`. The web open-link path loses opener access, matching the existing image-preview behavior. The narrow-panel workbench toolbar gained one action and the HTML preview shows a notice explaining why scripts do not run inline.

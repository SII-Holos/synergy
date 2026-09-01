# Decision Record: Default HTML files to an in-panel preview iframe

Status: implemented

## Problem

Opening an `.html`/`.htm` file in the Files workbench always landed in the Monaco source view. The only way to see the rendered page was the "Open in browser" pill added by [Open workspace HTML files in a sandboxed browser tab](2026-08-31-workspace-html-open-in-browser.md), which leaves the app for every glance at the output. Markdown and SVG files already default to a rendered preview with a Source/Preview toggle; HTML was the odd one out, and the in-panel iframe that earlier record deferred had a second, harder blocker: the global CSP middleware sets `X-Frame-Options: DENY` on every response, so even a same-origin iframe of the raw route is refused by the browser.

## Decision

Classify HTML as a dual (previewable) kind in the file workbench and serve the raw route frameable by same-origin pages:

- `classifyFilePreview()` returns `{ kind: "html", defaultMode: "preview", dual: true }` for `.html`/`.htm`, so HTML files open in Preview by default and gain the existing Source/Preview toggle, the `Cmd/Ctrl+Shift+V` shortcut, and per-file mode persistence shared with Markdown and SVG.
- The preview is an `<iframe sandbox="allow-scripts">` pointed at the existing `GET /workspace/files/raw/{scope}/{path...}` route from the earlier record, so relative resources keep resolving and the document still lands in a CSP-sandboxed opaque origin.
- The raw route now sets `X-Frame-Options: SAMEORIGIN`, overriding the middleware's blanket `DENY`. Same-origin pages (the Synergy SPA, including reverse-proxy deployments where app and iframe share one origin) may frame it; cross-site framing remains blocked. The sandbox CSP on script-capable documents is unchanged, so the framed page still cannot reach the app origin, storage, or control plane even though it is technically same-origin.

## Alternatives considered

- **Inline `srcdoc` preview sanitized with DOMPurify** (the attachment workbench pattern) — rejected: the workspace raw route already solves relative-resource resolution and script execution, which `srcdoc` sanitization gives up. The only missing piece was the frame header, one line versus a parallel rendering pipeline.
- **`frame-ancestors 'self'` on the raw route instead of `X-Frame-Options`** — rejected for this change: the middleware overwrites neither when the route sets a header, and `SAMEORIGIN` is the minimal override mirroring the existing check's shape. Modernizing the global header strategy is a separate decision.
- **Iframe embed as the earlier record's deferred plan, without the raw route** — already rejected there: relative resources 404 and get ORB-blocked. This record keeps the path-shaped raw route and only revisits the "new tab vs. embedded" UI choice.

## Consequences

HTML files open rendered by default, matching Markdown and SVG preview behavior; users who live in the source can toggle once per file and have it stick. The "Open in browser" pill stays for full-page work. `X-Frame-Options: SAMEORIGIN` now applies to every file served by the raw route (not only HTML), which also permits future same-origin framing of other types; cross-site clickjacking risk stays closed. This supersedes the "new tab for now" note in [Open workspace HTML files in a sandboxed browser tab](2026-08-31-workspace-html-open-in-browser.md) — the raw route and sandboxing decisions there are unchanged.

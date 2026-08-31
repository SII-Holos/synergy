# Decision Record: Open workspace HTML files in a sandboxed browser tab

Status: implemented

## Problem

Workspace HTML files inside the file workbench are viewable as source or a static preview, but scripts cannot run: users writing slide decks, dashboards, or interactive reports into a workspace have no way to see the rendered page with JavaScript executing. Serving the bytes raw from the existing `GET /workspace/files/content` query-style route (`?path=...&raw=true`) also breaks relative resources — an `<img src="assets/cover/image1.jpeg">` resolves against the query-bearing URL, dropping the file segment and 404-ing against the scope-required route prefix that then rejects the request with a `ScopeRequired` JSON body (which Chrome additionally blocks via ORB for image loads).

## Decision

Serve raw workspace files over a path-shaped route and surface an explicit "Open in browser" action in the file workbench:

- `WorkspaceFileService.serveFile()` reuses the existing `resolve()` + `assertRealpathInside()` + node checks to stream any file inside the workspace, with the same 50 MB preview ceiling as `content()`.
- `GET /workspace/files/raw/{scope}/{path...}` carries the scope in the path: the literal `home` or a base64url-encoded directory, decoded in `provideRequestScope` so the route needs no header/query scope. Because the URL is path-shaped and ends in the file name, relative `src`/`href` references in the HTML resolve to sibling paths under the same prefix automatically.
- HTML responses (`.html`/`.htm`) carry `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals`, mirroring the attachment asset route: scripts execute but the page lands in an opaque origin, so it cannot reach the app `localStorage`, the unauthenticated HTTP control plane, the event WebSocket, or the Desktop preload bridge. Non-HTML resources are served with their real MIME type and no sandbox CSP so images, CSS, scripts, and fonts load normally.
- Untrusted segments are rejected before touching the filesystem: empty paths, NUL bytes, absolute paths, and any `..` segment return 400/403/404 without leaking existence or content.
- The file workbench adds a toolbar "Open in browser" pill button (icon + label) shown only for `.html`/`.htm`, which builds the raw URL via `buildWorkspaceFileBrowserUrl(baseUrl, path, scope)` and opens it through `platform.openLink`, so web gets a new tab and Desktop goes through the shell.

`GET /workspace/files/content` returns to PDF-only duty; the OpenAPI/SDK artifacts were regenerated for the route shape change.

## Alternatives considered

- **Keep the query-style raw route and inject `<base href>`** — rejected: rewriting untrusted HTML server-side is fragile, breaks on existing `<base>` tags and absolute URLs, and still requires scope plumbing. A path-shaped URL solves resolution natively.
- **Serve arbitrary static files without a sandbox CSP on HTML** — rejected: a same-origin HTML page could read the app `localStorage` (pending auth) and drive the HTTP control plane. The sandboxed opaque origin keeps the feature useful (scripts run) without widening the trust boundary.
- **Iframe embed inside the workbench instead of a new tab** — rejected for now: the sandbox CSP applies the same way, but the workbench layout and keyboard/focus handling make an embedded preview a larger UI change; a new tab matches the attachment workbench's existing pattern.

## Consequences

Any workspace file type can now be fetched raw through the route, but only HTML gets the sandbox treatment; other types are byte pass-through with their real content type. Relative-resource paths work out of the box for nested directories (e.g. `resources/templates/01-cover-main/assets/cover/image1.jpeg`). The scope token in the URL is an obfuscated directory name, not a credential — the route remains as unauthenticated as the rest of the local control plane and is intended for same-machine links.

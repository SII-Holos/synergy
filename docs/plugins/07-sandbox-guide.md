# Sandbox Iframe and postMessage Guide

This guide explains how to build UI plugins that render inside a sandboxed iframe.
It covers the sandbox model, the postMessage protocol, the HTML shell the server
generates, and the component lifecycle.

> **Audience:** Plugin authors implementing panels, settings, or custom UI
> components that need an isolated execution context.

---

## When to use a sandbox iframe

Use a sandbox iframe when your plugin:

- Renders user-supplied or untrusted data (HTML, markdown, SVG)
- Includes third-party scripts whose behavior you cannot fully audit
- Needs to display rich interactive content (charts, editors, visualizers)
- Wants a DOM boundary: the plugin's CSS, JS, and layout cannot leak into or
  break the host application

Do **not** use a sandbox iframe when:

- Your component is purely declarative (icon + title + subtitleTemplate)
- Your component needs synchronous access to host state (use Tier 1
  declarative renderers or Tier 2 trusted imports instead)
- Your component renders inside the tool card area and only needs standard
  input/output display

---

## Sandbox model

Synergy sandboxed iframes use the following HTML attribute:

```html
<iframe sandbox="allow-scripts" src="..."></iframe>
```

### What `sandbox="allow-scripts"` means

| Restriction           | Enforced? | Effect                                         |
| --------------------- | --------- | ---------------------------------------------- |
| Same-origin access    | Blocked   | iframe gets an **opaque origin** — no cookies, |
|                       |           | no localStorage, no sessionStorage access      |
| Form submission       | Blocked   | `form.submit()` does nothing                   |
| Popup windows         | Blocked   | `window.open()` is silently disabled           |
| Pointer lock          | Blocked   | Cannot lock the pointer                        |
| Navigation            | Blocked   | Cannot navigate the parent frame               |
| Scripts               | Allowed   | JavaScript executes normally                   |
| CSS / layout          | Allowed   | Full styling capability                        |
| postMessage to parent | Allowed   | The sole communication channel to the host     |

### Opaque origin consequences

Because the iframe has an opaque origin:

- `window.origin` is `"null"`
- `document.cookie` is empty and writeable only within the iframe's own
  ephemeral storage
- `localStorage` and `sessionStorage` throw `SecurityError` on access
- Cross-origin requests that depend on cookies or `Authorization` headers
  must be relayed through the host via postMessage

### CSP applied to the sandbox page

The server serves the sandbox HTML shell with a Content-Security-Policy header
that enforces:

```
default-src 'self'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';
img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'
```

- **Scripts** must come from the plugin's asset endpoint
  (`/plugin/assets/:pluginId/:version/...`) or be inline.
- **Styles** can be inline or loaded from the asset endpoint.
- **Images** can be served from the asset endpoint, `data:` URIs, or `blob:`
  URIs.
- **Network requests** (`fetch`, `XMLHttpRequest`) are blocked unless relayed
  through the host postMessage bridge.
- **Frames** and **plugins** (Flash, PDF.js) are blocked entirely.

> Plugins that need to fetch external APIs must declare `connectDomains` in
> their manifest permissions and use the postMessage bridge relay.

---

## HTML shell

When a panel declares `sandbox: true`, the frontend renders an iframe whose
`src` points to `GET /plugin/:pluginId/sandbox/:panelId`.

The server responds with this HTML shell (simplified):

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        margin: 0;
        font-family: system-ui;
      }
    </style>
  </head>
  <body>
    <script src="/plugin/assets/my-plugin/1.0.0/dist/ui.js"></script>
  </body>
</html>
```

The server resolves the script `src` from the panel's manifest entry:

1. `panel.sandboxEntry` — panel-specific sandbox entry point
2. `ui.entry` — plugin-wide UI entry point
3. `"dist/ui.js"` — default fallback

The plugin's JS bundle must bootstrap itself: call `plugin.ready()`, set up
event listeners, and render into the (initially empty) `<body>`.

---

## PostMessage protocol

All communication between the sandboxed iframe and the host happens through
`window.postMessage()` with **strict origin validation** on both sides.

### Origin validation

The host only accepts messages whose `origin` is `"null"` (the opaque origin
of the sandboxed iframe). The iframe only sends messages to the host's
explicit origin, which is provided at initialization time.

```js
// Inside the sandboxed iframe — always specify targetOrigin
window.parent.postMessage({ type: "plugin.ready" }, "https://app.synergy.example")
```

### Message types

#### 1. `plugin.ready`

Sent by the sandboxed plugin once its entry script has loaded and the UI is
ready to render.

```json
{ "type": "plugin.ready", "pluginId": "my-plugin", "panelId": "my-panel" }
```

#### 2. `plugin.resize`

Sent when the plugin content height changes (e.g., after data load or user
interaction), so the host can adjust the iframe height.

```json
{ "type": "plugin.resize", "height": 600 }
```

#### 3. `rpc.request`

Calls a host-side method. The host relays the call to the Synergy server
via the `POST /plugin/:pluginId/interact` endpoint.

```json
{
  "type": "rpc.request",
  "method": "config.get",
  "input": {},
  "id": 1
}
```

#### 4. `rpc.result`

Response to a prior `rpc.request`. Delivered back to the iframe.

```json
{
  "type": "rpc.result",
  "result": { "theme": "dark" },
  "id": 1
}
```

#### 5. `plugin.action`

Triggers a host-side navigation or side effect (open a URL, switch panels,
show a toast).

```json
{
  "type": "plugin.action",
  "action": "navigate",
  "payload": { "path": "/settings" }
}
```

Supported action values:

| Action       | Effect                               |
| ------------ | ------------------------------------ |
| `navigate`   | Navigate the host to a new route     |
| `toast`      | Show a host toast notification       |
| `openUrl`    | Open a URL in a new browser tab      |
| `sendToChat` | Insert a message into the chat input |

#### 6. `plugin.error`

Reports an unhandled error from within the sandbox for host-side logging and
display.

```json
{
  "type": "plugin.error",
  "message": "Failed to load data",
  "stack": "Error: ..."
}
```

#### 7. `plugin.configChanged`

Informs the host that the plugin's config should be persisted. The host calls
`PATCH /plugin/:pluginId/config` on the server.

```json
{
  "type": "plugin.configChanged",
  "config": { "apiKey": "sk-..." }
}
```

### RPC bridge

For RPC-style calls (`rpc.request` / `rpc.result`), the host uses a simple
request-response model:

```
iframe → host:    { type: "rpc.request", method, input, id }
host → server:    POST /plugin/:pluginId/interact { type, payload }
server → host:    { status: "received", type }
host → iframe:    { type: "rpc.result", result, id }
```

The RPC helper (`Rpc.client` / `Rpc.listen` in the codebase) wraps this
pattern with promises and message correlation.

---

## Lifecycle

A sandboxed plugin panel follows this lifecycle:

```
  [Host mounts iframe]
         │
         ▼
  [iframe loads HTML shell]
         │
         ▼
  [Shell loads entry script via <script src=...>]
         │
         ▼
  [Script bootstraps UI, calls plugin.ready()]
         │
         ▼
  ┌───── Running ──────────────────────┐
  │  • RPC calls between sandbox/host  │
  │  • User interactions in sandbox    │
  │  • plugin.resize events as needed  │
  └────────────────────────────────────┘
         │
         ▼
  [Host unmounts panel / user navigates away]
         │
         ▼
  [Host sends plugin.dispose message]
         │
         ▼
  [Iframe removed from DOM]
```

### Mount

1. The host creates an `<iframe>` element with `sandbox="allow-scripts"`.
2. The iframe loads the HTML shell from `/plugin/:pluginId/sandbox/:panelId`.
3. The shell loads the entry JavaScript bundle.
4. During bootstrap, the plugin should render its UI into the `<body>`.
5. The plugin sends `plugin.ready` to signal completion.

### Running

- The plugin communicates exclusively via `postMessage`.
- The plugin may send `plugin.resize` when its content height changes.
- The plugin uses `rpc.request`/`rpc.result` for host API calls.
- The host may forward tool calls or session events into the sandbox.

### Unmount

1. The user navigates away or the panel is closed.
2. The host sends a `plugin.dispose` message to the iframe:

```json
{ "type": "plugin.dispose" }
```

1. The plugin should clean up timers, abort pending requests, and free
   resources.
2. The host removes the iframe from the DOM.

### Destroy

The iframe element is removed. All JS state, DOM content, and event listeners
in the iframe are garbage-collected. No explicit cleanup is required from the
plugin after this point.

---

## Declaring a sandboxed panel in the manifest

In your `plugin.json`, set `sandbox: true` on the panel or settings entry:

```json
{
  "version": "1.0.0",
  "permissions": {
    "ui": {
      "sandboxIframe": true
    }
  },
  "contributes": {
    "ui": {
      "entry": "dist/ui.js",
      "workspacePanels": [
        {
          "id": "my-chart-panel",
          "label": "Charts",
          "icon": "bar-chart",
          "sandbox": true,
          "sandboxEntry": "dist/chart-panel.js"
        }
      ],
      "settings": [
        {
          "id": "my-settings",
          "label": "Plugin Settings",
          "icon": "settings",
          "group": "plugins",
          "sandbox": true,
          "sandboxEntry": "dist/settings.js"
        }
      ]
    }
  }
}
```

The `sandbox` flag tells the frontend to render the panel or settings page
inside a sandboxed iframe instead of using a trusted import.

The `sandboxEntry` field specifies the JS entry point relative to the plugin
package root. If omitted, the plugin-wide `ui.entry` is used, falling back to
`dist/ui.js`.

---

## Complete example: sandboxed settings form

This example shows a settings panel that loads a user's API key from the host,
renders a form, and persists changes.

### manifest declaration (`plugin.json`)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "permissions": {
    "ui": { "sandboxIframe": true }
  },
  "contributes": {
    "ui": {
      "entry": "dist/ui.js",
      "settings": [
        {
          "id": "my-plugin-settings",
          "label": "My Plugin",
          "icon": "settings",
          "group": "plugins",
          "sandbox": true,
          "sandboxEntry": "dist/settings.js"
        }
      ]
    }
  }
}
```

### sandbox entry script (`dist/settings.js`)

```js
;(function () {
  const HOST_ORIGIN = "https://app.synergy.example"

  function post(type, payload) {
    window.parent.postMessage({ type, ...payload }, HOST_ORIGIN)
  }

  // 1. Declare readiness
  post("plugin.ready", { pluginId: "my-plugin", panelId: "my-plugin-settings" })

  // 2. Request current config
  post("rpc.request", { method: "config.get", input: {}, id: 1 })

  // 3. Listen for RPC results
  let resolveConfig
  const configPromise = new Promise((resolve) => {
    resolveConfig = resolve
  })

  window.addEventListener("message", (evt) => {
    if (evt.origin !== HOST_ORIGIN) return

    const msg = JSON.parse(evt.data)
    if (msg.type === "rpc.result" && msg.id === 1) {
      resolveConfig(msg.result)
    }
  })

  // 4. Build and render the form once config arrives
  configPromise.then((config) => {
    const form = document.createElement("form")
    form.innerHTML = `
      <label>
        API Key
        <input name="apiKey" value="${escapeHtml(config.apiKey || "")}" />
      </label>
      <label>
        Max Results
        <input name="maxResults" type="number" value="${config.maxResults ?? 10}" />
      </label>
      <button type="submit">Save</button>
    `

    form.addEventListener("submit", (e) => {
      e.preventDefault()
      const data = new FormData(form)

      const newConfig = {
        apiKey: data.get("apiKey"),
        maxResults: parseInt(data.get("maxResults"), 10) || 10,
      }

      post("plugin.configChanged", { config: newConfig })

      // Show feedback
      const status = document.createElement("p")
      status.textContent = "Saved!"
      form.appendChild(status)
      setTimeout(() => status.remove(), 2000)
    })

    document.body.appendChild(form)
  })

  // 5. Handle dispose
  window.addEventListener("message", (evt) => {
    if (evt.origin !== HOST_ORIGIN) return

    const msg = JSON.parse(evt.data) // could also be direct object
    if (typeof msg === "object" && msg.type === "plugin.dispose") {
      // Cleanup
      document.body.innerHTML = ""
    }
  })

  function escapeHtml(str) {
    if (typeof str !== "string") return ""
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  }
})()
```

---

## Sandbox vs. trusted import

The manifest supports two isolation tiers for UI components:

| Tier | Mechanism          | DOM isolation | CSS isolation | Host API access    | Use case                      |
| ---- | ------------------ | ------------- | ------------- | ------------------ | ----------------------------- |
| 1    | Declarative render | N/A           | N/A           | Pre-computed props | Simple tool cards, icon+title |
| 2    | Trusted import     | None          | None          | Full SolidJS hooks | Complex panels in trusted     |
|      |                    |               |               |                    | plugins (local file:// paths) |
| 3    | Sandbox iframe     | Full          | Full          | postMessage only   | Untrusted plugins, user data  |
|      |                    |               |               |                    | rendering, third-party code   |

**Choose Tier 3 (sandbox) when:**

- The plugin is installed from an npm registry (not a local `file://` path)
- The plugin renders user-supplied content (HTML, markdown, SVG)
- You want a hard DOM boundary between the plugin and the host
- The plugin includes third-party dependencies you haven't audited

**Choose Tier 2 (trusted) when:**

- The plugin is a local `file://` plugin
- The plugin needs direct access to SolidJS context, routing, or host APIs
- The plugin code is fully under your control and review

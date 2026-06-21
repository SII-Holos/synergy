# Security Best Practices for Plugin Authors

This guide describes the security model of the Synergy plugin system and
recommended practices for plugin authors.

> **Audience:** Plugin authors who want to build secure plugins and understand
> the trust boundaries enforced by the host.

---

## Trust tiers

The plugin system defines three trust tiers. Every plugin is classified into
one tier based on its installation path.

| Tier | Name        | Mechanism        | Installation path           | Host API access           |
| ---- | ----------- | ---------------- | --------------------------- | ------------------------- |
| 1    | Declarative | Manifest-only    | Any                         | Pre-computed props only   |
| 2    | Trusted     | Dynamic import   | `file://` local path        | Full SolidJS host context |
| 3    | Sandbox     | Sandboxed iframe | Registry (npm) package path | postMessage bridge only   |

### How the host determines the tier

The server classifies a plugin at runtime using the `determineTrustTier()`
function in `packages/synergy/src/server/plugin-routes.ts`:

```ts
function determineTrustTier(pluginDir: string): "trusted" | "sandbox" {
  const cacheRoot = Global.Path.cache
  const relative = path.relative(cacheRoot, pluginDir)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "trusted"
  }
  return "sandbox"
}
```

- Plugins outside the cache directory (`~/.synergy/cache/node_modules/...`)
  are **trusted**.
- Plugins inside the cache directory (installed from npm) are **sandboxed**.

### Choosing the right tier

**Declarative (Tier 1):** Use when you only need icon, title, and subtitle
for a tool card. No JS component is loaded. Your tool output is rendered by
the host's standard text renderer.

**Trusted (Tier 2):** Use when:

- You control the installation path (local `file://` plugin)
- Your component needs direct access to SolidJS context, router, or host APIs
- You have audited all dependencies in the plugin bundle

**Sandbox (Tier 3):** Use when:

- The plugin is published to a registry and installed from npm
- Your component renders user-supplied content (HTML, SVG, markdown)
- You want a hard DOM/display boundary between your plugin and the host
- Your plugin includes third-party dependencies you haven't fully audited
- You want to limit blast radius: a vulnerability in your plugin cannot access
  host state, cookies, or localStorage

---

## Plugin-side security

### 1. Sanitize user input

If your plugin receives user input — from tool arguments, config values, or
session data — sanitize it before using it in DOM operations, even inside a
sandbox.

```js
// UNSAFE: Direct innerHTML with user input
element.innerHTML = userInput

// SAFE: Create text nodes
element.textContent = userInput

// SAFE (when HTML is intentional): Use a sanitizer
import DOMPurify from "dompurify"
element.innerHTML = DOMPurify.sanitize(userInput)
```

Sandboxed iframes prevent same-origin access, but XSS inside the sandbox
can still:

- Steal data visible within the iframe (API keys displayed on the page)
- Submit forged `postMessage` requests to the host
- Modify the sandbox DOM to phish user actions

### 2. Don't trust manifest data in HTML templates

The manifest `fallback` block and other metadata fields are strings. If you
read them at runtime and inject them into HTML, treat them as untrusted:

```js
// UNSAFE: manifest.fallback.title injected into HTML
element.innerHTML = `<h1>${manifest.fallback.title}</h1>`

// SAFE: Always use textContent for non-HTML data
element.textContent = manifest.fallback.title
```

### 3. Validate postMessage origin

Every `message` event handler in your plugin must validate the origin:

```js
const HOST_ORIGIN = "https://app.synergy.example"

window.addEventListener("message", (event) => {
  // Always check origin — even inside a sandbox
  if (event.origin !== HOST_ORIGIN) return

  const msg = JSON.parse(event.data)
  // ... handle message
})
```

The host origin should be provided at plugin init time and never hardcoded
from `window.location.origin` (which is `"null"` in a sandbox).

### 4. Scope network requests through the host

Sandboxed plugins cannot make direct `fetch()` calls to external APIs. If
your plugin needs network access, declare permissions and relay through the
host postMessage bridge.

Do **not** work around the sandbox by:

- Using `<img>` or `<script>` tags to exfiltrate data (partially blocked by
  CSP)
- Opening new windows (blocked by sandbox attribute)
- Using DNS prefetch or link prefetch (blocked by CSP)

### 5. Clean up on dispose

When the host sends `plugin.dispose`, clean up all resources:

```js
window.addEventListener("message", (event) => {
  if (event.origin !== HOST_ORIGIN) return

  const msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data
  if (msg.type === "plugin.dispose") {
    clearTimeout(this.timer)
    this.abortController?.abort()
    this.ws?.close()
    document.body.innerHTML = "" // clear DOM
  }
})
```

Unclosed resources (WebSocket connections, intervals, observers) can leak
memory and cause unexpected behavior after the iframe is unmounted.

---

## Host-side security

### 1. Path containment

The server validates all plugin asset requests to prevent path traversal:

```ts
function checkPathContainment(base: string, filePath: string): string | null {
  const resolved = path.resolve(base, filePath)
  const relative = path.relative(base, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null
  }
  return resolved
}
```

This is used for `GET /api/plugins/assets/:pluginId/:versionHash/*` to ensure
plugins can only serve files from their own directory.

### 2. Content Security Policy

The sandbox HTML shell and the main application use Content Security Policy
headers to restrict what resources can be loaded:

```
default-src 'self'; script-src 'unsafe-inline' 'unsafe-eval';
style-src 'unsafe-inline'; img-src 'self' data: blob:;
connect-src 'self'; frame-src 'none'; object-src 'none'
```

- **No external scripts** — all script sources are from the plugin asset
  endpoint or inline
- **No external images** — images must be served from the same origin,
  `data:` URIs, or `blob:` URIs
- **No frames** — plugins cannot embed other iframes
- **No plugins** — Flash, PDF.js, and similar are blocked

### 3. Iframe sandbox attribute

The `SandboxShell` component renders every sandboxed plugin with:

```tsx
<iframe sandbox="allow-scripts" ... />
```

This attribute:

- Creates an opaque origin (`"null"`)
- Blocks form submission
- Blocks popups
- Blocks top-level navigation
- Blocks pointer lock
- Blocks same-origin access (no cookies, no localStorage)
- Allows only JavaScript execution

The host **never** uses `allow-same-origin` or `allow-top-navigation` on
plugin iframes. Those would defeat the isolation.

### 4. postMessage validation

The host validates all incoming postMessage messages in
`packages/app/src/plugin/sandbox/postmessage-bridge.ts`:

```ts
export function isValidOrigin(origin: string, hostOrigin: string): boolean {
  // Sandboxed iframes get opaque origin "null"
  return origin === hostOrigin || origin === "null"
}

export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (typeof data !== "object" || data === null) return null
  const msg = data as Record<string, unknown>
  if (typeof msg.type !== "string") return null
  const validTypes = new Set([
    "plugin.ready",
    "plugin.init",
    "plugin.action",
    "host.action",
    "plugin.resize",
    "plugin.toast",
    "plugin.error",
  ])
  if (!validTypes.has(msg.type)) return null
  return data as BridgeMessage
}
```

The host only accepts messages from the opaque origin (`"null"`) and only
messages with a recognized type. All other messages are silently discarded.

### 5. Trusted import (Tier 2) isolation

For Tier 2 (trusted) plugins, the host uses dynamic `import()` to load the
plugin's JS bundle:

```ts
const mod = await import(/* @vite-ignore */ url)
```

The `@vite-ignore` comment prevents Vite from resolving the import at build
time. The URL is constructed from the plugin's asset endpoint:

```ts
const url = `/plugin/assets/${pluginId}/${version}/${entry}`
```

**Risks of Tier 2:**

- The bundle runs in the same JS context as the host application
- It can access any host API, DOM element, or global state
- An XSS in the plugin component is a host-level XSS

**Mitigations:**

- Only local `file://` plugins get Tier 2 — registry plugins are sandboxed
- Plugin authors should audit their bundle dependencies carefully
- The host can deactivate a plugin at any time by running its disposers

---

## Permissions model

The plugin manifest declares permissions in the `permissions` field. Every
permission is an opt-in — the default is `false` or `"none"`.

```json
{
  "permissions": {
    "ui": {
      "toolRenderers": true,
      "sandboxIframe": true,
      "trustedImport": false
    },
    "network": {
      "connectDomains": ["api.example.com"],
      "resourceDomains": ["cdn.example.com"]
    },
    "data": {
      "session": "read",
      "workspace": "none",
      "config": "plugin"
    },
    "tools": {
      "invoke": true,
      "shell": false,
      "filesystem": false
    }
  }
}
```

### Permission categories

#### `permissions.ui`

Controls what UI surfaces the plugin can contribute to.

| Permission        | Default | Effect                                     |
| ----------------- | ------- | ------------------------------------------ |
| `toolRenderers`   | `false` | Register custom tool card renderers        |
| `partRenderers`   | `false` | Register custom message part renderers     |
| `workspacePanels` | `false` | Add panels to the workspace sidebar        |
| `globalPanels`    | `false` | Add panels to the global sidebar           |
| `settings`        | `false` | Add sections to the settings dialog        |
| `themes`          | `false` | Contribute custom themes                   |
| `icons`           | `false` | Register custom icons                      |
| `routes`          | `false` | Add custom application routes              |
| `trustedImport`   | `false` | Allow dynamic import (Tier 2, same-origin) |
| `sandboxIframe`   | `false` | Render panels in sandboxed iframe (Tier 3) |

#### `permissions.network`

Controls what external hosts the plugin can interact with.

| Permission        | Default | Effect                                       |
| ----------------- | ------- | -------------------------------------------- |
| `connectDomains`  | `[]`    | Domains the plugin may connect to via fetch  |
| `resourceDomains` | `[]`    | Domains for loading resources (images, etc.) |
| `frameDomains`    | `[]`    | Domains allowed in iframe `src` (currently   |
|                   |         | blocked by CSP)                              |

#### `permissions.data`

Controls access to Synergy data.

| Permission  | Default    | Effect                                   |
| ----------- | ---------- | ---------------------------------------- |
| `session`   | `"none"`   | `"metadata"` = list sessions; `"read"` = |
|             |            | read session content                     |
| `workspace` | `"none"`   | `"read"` = read workspace files          |
| `config`    | `"plugin"` | `"plugin"` = own config; `"global"` =    |
|             |            | read/write any config                    |

#### `permissions.tools`

Controls runtime tool execution permissions.

| Permission   | Default | Effect                                 |
| ------------ | ------- | -------------------------------------- |
| `invoke`     | `true`  | Allow plugin tools to be invoked       |
| `shell`      | `false` | Allow plugin to execute shell commands |
| `filesystem` | `false` | Allow plugin to read/write files       |

### Least privilege principle

Declare only the permissions your plugin actually needs.

```json
// A plugin that only renders a chart panel:
{
  "permissions": {
    "ui": { "workspacePanels": true, "sandboxIframe": true }
  }
}

// A plugin that provides a custom tool:
{
  "permissions": {
    "ui": { "toolRenderers": true },
    "data": { "session": "metadata" }
  }
}
```

If your plugin doesn't use a capability, don't request it. Permission
granting is up to the user and the host configuration.

---

## Common pitfalls

### 1. SVG injection

SVG is HTML and can contain `<script>` tags and event handlers.

```js
// UNSAFE: SVG can carry scripts
element.innerHTML = `<svg><script>alert(1)</script></svg>`
```

In a sandbox, XSS inside SVG cannot access the host, but it can still
manipulate the sandbox DOM. Always sanitize SVG content or use
`DOMParser.parseFromString(svg, "image/svg+xml")` for safe SVG parsing.

### 2. Dynamic import in sandbox

Dynamic `import()` does not work inside a `sandbox="allow-scripts"` iframe
because the iframe has no module execution permissions. To load code:

- Bundle all code into a single entry script (use your build tool, e.g.,
  esbuild, rollup, or Vite with `build.lib` mode)
- Load data via postMessage RPC, not dynamic imports

### 3. Over-broad network access

Even inside a sandbox, a plugin can exfiltrate data if `connectDomains` or
`resourceDomains` are too permissive.

**Don't:**

```json
{ "permissions": { "network": { "resourceDomains": ["*"] } } }
```

**Do:**

```json
{ "permissions": { "network": { "resourceDomains": ["api.example.com"] } } }
```

### 4. Relying on opaque origin for secrets

An opaque origin prevents the iframe from accessing host cookies or
localStorage, but it does **not** prevent the iframe from sending messages
to the host. Don't store secrets in the iframe and assume they're safe from
exfiltration.

### 5. Skipping postMessage origin checks

The `message` event always carries an `origin` property. Always check it —
even if you think the message can only come from your iframe. Any window on
any origin can call `postMessage()` on your window.

```js
// ALWAYS check origin:
if (event.origin !== EXPECTED_HOST_ORIGIN) return

// NEVER accept '*' wildcard
window.addEventListener("message", (event) => {
  // Missing origin check! Any website can send messages here.
  handleMessage(event.data)
})
```

### 6. Injecting untrusted data into manifest UI elements

The manifest's `label`, `description`, and `subtitleTemplate` fields are
user-facing strings. When these come from a plugin you did not author, treat
them as untrusted:

```tsx
// In the host — label from untrusted plugin manifest
// UNSAFE: React/Solid JSX auto-escapes, but direct innerHTML does not
element.innerHTML = plugin.label

// SAFE: let the framework handle escaping
element.textContent = plugin.label
```

---

## Checklist for plugin review

When reviewing a plugin for security, verify each item:

### Manifest review

- [ ] `permissions` declares only the minimum required capabilities
- [ ] UI surface flags match what the plugin actually contributes
- [ ] Network domains are specific, not wildcards
- [ ] Data access is scoped to `"plugin"` unless global access is required
- [ ] No unnecessary `trustedImport` or `sandboxIframe` permissions

### Trusted plugin (Tier 2) review

- [ ] Bundle dependencies are audited (no known-vulnerable packages)
- [ ] No raw `innerHTML` or `dangerouslySetInnerHTML` with untrusted input
- [ ] Component does not exfiltrate host state via network requests
- [ ] Cleanup logic (dispose) is implemented for timers and subscriptions
- [ ] No global event listeners added without cleanup

### Sandbox plugin (Tier 3) review

- [ ] `sandboxIframe` is granted only when necessary
- [ ] All `postMessage` handlers validate `event.origin`
- [ ] No `eval()` or `new Function()` with untrusted input
- [ ] SVG injection is prevented (sanitize or use textContent)
- [ ] All code is bundled into the entry script (no dynamic imports)
- [ ] Dispose handler cleans up intervals, observers, and WebSockets

### Runtime behavior

- [ ] Plugin does not attempt to bypass path containment (relative path traversal)
- [ ] Plugin does not open popups or navigate the parent frame
- [ ] Plugin does not load resources from unexpected domains
- [ ] Error messages from the plugin do not leak sensitive data
- [ ] Plugin tool output does not inject unescaped HTML in tool cards

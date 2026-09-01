import { describe, expect, test } from "bun:test"
import { pluginStatusRow, startupScopeLabel } from "../../src/server/runtime"
import { Server } from "../../src/server/server"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"
import { Global } from "../../src/global"
import { Asset } from "../../src/asset/asset"
import { Plugin } from "../../src/plugin"
import fs from "fs/promises"
import path from "path"

describe("server runtime startup output", () => {
  test("startup scope label does not require a scope context", () => {
    expect(() => startupScopeLabel()).not.toThrow()
    expect(startupScopeLabel()).toBeTruthy()
  })

  test("reports the plugin registry state instead of relying on loader events", () => {
    expect(pluginStatusRow([], [])).toEqual({ label: "Plugins", value: "none configured", kind: "muted" })
    expect(pluginStatusRow([{ id: "focus", name: "FOCUS" }], [])).toEqual({
      label: "Plugins",
      value: "FOCUS",
      kind: "success",
    })
    expect(
      pluginStatusRow(
        [{ id: "focus", name: "FOCUS" }],
        [{ pluginId: "git+ssh://git@github.com/SII-Holos/holos-research" }],
      ),
    ).toEqual({ label: "Plugins", value: "FOCUS; 1 unavailable: holos-research", kind: "error" })
  })
})

describe("server request scope boundaries", () => {
  test("global routes do not require directory and do not resolve a project scope", async () => {
    const original = Scope.fromDirectory
    let called = false
    ;(Scope as any).fromDirectory = async () => {
      called = true
      throw new Error("global route resolved a project scope")
    }
    try {
      const app = Server.App()
      const response = await app.request("/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: "test", level: "info", message: "hello" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toBe(true)
      expect(called).toBe(false)
    } finally {
      ;(Scope as any).fromDirectory = original
    }
  })

  test("scoped routes return ScopeRequired when directory is missing", async () => {
    const app = Server.App()
    const response = await app.request("/path", { method: "GET" })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.name).toBe("ScopeRequired")
  })

  test("global paths route does not require a scope", async () => {
    const app = Server.App()
    const response = await app.request("/global/paths", { method: "GET" })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.home).toBe(Global.Path.home)
    expect(body.root).toBe(Global.Path.root)
  })

  test("asset route does not require a scope", async () => {
    const app = Server.App()
    const id = await Asset.write(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'),
      "image/svg+xml",
      "demo.svg",
    )

    const response = await app.request(`/asset/${id}`, { method: "GET" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("image/svg+xml")
    expect(await response.text()).toContain("<svg")
  })

  test("html assets render in a sandboxed opaque origin", async () => {
    const app = Server.App()
    const id = await Asset.write(
      Buffer.from("<!doctype html><title>x</title><script>1</script>"),
      "text/html",
      "demo.html",
    )

    const response = await app.request(`/asset/${id}`, { method: "GET" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
    )
  })

  test("svg assets also render in a sandboxed opaque origin", async () => {
    const app = Server.App()
    const id = await Asset.write(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'),
      "image/svg+xml",
      "demo.svg",
    )

    const response = await app.request(`/asset/${id}`, { method: "GET" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("image/svg+xml")
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
    )
  })

  test("non-script-capable assets do not receive the sandbox policy", async () => {
    const app = Server.App()
    const id = await Asset.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", "demo.png")

    const response = await app.request(`/asset/${id}`, { method: "GET" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("image/png")
    expect(response.headers.get("content-security-policy")).not.toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
    )
  })

  test("scoped routes use home scopeID without resolving a project directory", async () => {
    const original = Scope.fromDirectory
    let called = false
    ;(Scope as any).fromDirectory = async () => {
      called = true
      throw new Error("home scope resolved a project directory")
    }
    try {
      const app = Server.App()
      const response = await app.request("/path?scopeID=home", { method: "GET" })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.directory).toBe(Global.Path.home)
      expect(called).toBe(false)
    } finally {
      ;(Scope as any).fromDirectory = original
    }
  })

  test("scoped routes use the explicit directory when provided", async () => {
    await using tmp = await tmpdir()
    const app = Server.App()
    const response = await app.request(`/path?directory=${encodeURIComponent(tmp.path)}`, { method: "GET" })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.directory).toBe(tmp.path)
  })

  test("hybrid routes use explicit directory when provided", async () => {
    await using tmp = await tmpdir({
      config: {
        model: "test-provider/test-model",
      },
    })
    const app = Server.App()
    const response = await app.request(`/config?directory=${encodeURIComponent(tmp.path)}`, { method: "GET" })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.model).toBe("test-provider/test-model")
  })

  test("plugin UI APIs use the explicit project scope while plugin assets stay global", async () => {
    await using tmp = await tmpdir()
    const pluginDir = path.join(tmp.path, "plugin")
    const assetPath = path.join(pluginDir, "ui", "index.js")
    await fs.mkdir(path.dirname(assetPath), { recursive: true })
    await Bun.write(assetPath, "export const panel = true\n")

    const originalGetLoaded = Plugin.getLoaded
    const originalGet = Plugin.get
    const fake = {
      id: "focus",
      name: "FOCUS",
      pluginDir,
      manifest: {
        version: "0.1.0",
        capabilities: [],
        contributions: [
          { kind: "ui.workbenchPanel", id: "research-map" },
          { kind: "operation", id: "research.graph.get", type: "query", expose: ["ui"] },
          { kind: "operation", id: "admin.reset", type: "command", expose: ["sdk"] },
          { kind: "event", id: "research.graph.changed" },
          { kind: "tool", id: "internal-tool" },
        ],
        artifacts: { generation: "generation-one", ui: { entry: "ui/index.js", sha256: "test" } },
      },
    } as any
    ;(Plugin as any).getLoaded = async () => [fake]
    ;(Plugin as any).get = async (id: string) => (id === "focus" ? fake : undefined)
    try {
      const app = Server.App()
      const contributions = await app.request("/plugin/ui/contributions", {
        headers: { "x-synergy-directory": tmp.path },
      })
      expect(contributions.status).toBe(200)
      const body = await contributions.json()
      expect(body[0].scopeId).toBe((await tmp.scope()).id)
      expect(body[0].contributions.map((item: { kind: string; id: string }) => `${item.kind}:${item.id}`)).toEqual([
        "ui.workbenchPanel:research-map",
        "operation:research.graph.get",
        "event:research.graph.changed",
      ])

      const asset = await app.request("/plugin/assets/focus/generation-one/ui/index.js")
      expect(asset.status).toBe(200)
      expect(asset.headers.get("content-type")).toContain("text/javascript")
      expect(await asset.text()).toContain("panel = true")
    } finally {
      ;(Plugin as any).getLoaded = originalGetLoaded
      ;(Plugin as any).get = originalGet
    }
  })
})

describe("global event origin allowlist", () => {
  test("allows the server's own origin over WebSocket", () => {
    expect(
      Server.globalEventOriginAllowed("http://localhost:3000", "ws://localhost:3000/global/event/ws?stream=delta"),
    ).toBe(true)
  })

  test("allows loopback-to-loopback peers", () => {
    expect(Server.globalEventOriginAllowed("http://127.0.0.1:4000", "ws://localhost:3000/global/event/ws")).toBe(true)
  })

  test("rejects missing origins", () => {
    expect(Server.globalEventOriginAllowed(undefined, "ws://localhost:3000/global/event/ws")).toBe(false)
  })

  test("rejects opaque sandboxed origins", () => {
    expect(Server.globalEventOriginAllowed("null", "ws://localhost:3000/global/event/ws")).toBe(false)
  })

  test("rejects cross-origin pages", () => {
    expect(Server.globalEventOriginAllowed("https://evil.example", "ws://localhost:3000/global/event/ws")).toBe(false)
  })

  test("allows the same host behind TLS-terminating reverse proxies", () => {
    expect(
      Server.globalEventOriginAllowed(
        "https://synergy.internal.example",
        "ws://synergy.internal.example/global/event/ws",
      ),
    ).toBe(true)
  })

  test("rejects cross-origin pages sharing the request host suffix", () => {
    expect(
      Server.globalEventOriginAllowed(
        "https://synergy.internal.example.evil.example",
        "ws://synergy.internal.example/global/event/ws",
      ),
    ).toBe(false)
  })

  test("allows explicitly allowlisted origins such as reverse-proxy domains", () => {
    const extras = ["https://synergy.internal.example:8443"]
    expect(
      Server.globalEventOriginAllowed(
        "https://synergy.internal.example:8443",
        "ws://127.0.0.1:3000/global/event/ws",
        extras,
      ),
    ).toBe(true)
  })

  test("normalizes configured allowlist origins to the canonical browser form", () => {
    expect(Server.normalizeCorsOrigin("https://EXAMPLE.com:443")).toBe("https://example.com")
    expect(Server.normalizeCorsOrigin("http://localhost:80")).toBe("http://localhost")
    expect(Server.normalizeCorsOrigin("https://synergy.internal.example:8443")).toBe(
      "https://synergy.internal.example:8443",
    )
    expect(Server.normalizeCorsOrigin("not-a-url")).toBeUndefined()
    expect(Server.normalizeCorsOrigin("ftp://example.com")).toBeUndefined()
  })

  test("matches allowlisted origins against the normalized origin the browser sends", () => {
    const configured = ["https://EXAMPLE.com:443"]
    const extras = configured.flatMap((origin) => {
      const normalized = Server.normalizeCorsOrigin(origin)
      return normalized ? [normalized] : []
    })
    expect(Server.globalEventOriginAllowed("https://example.com", "ws://127.0.0.1:3000/global/event/ws", extras)).toBe(
      true,
    )
  })

  test("rejects non-http(s) request schemes even when the host matches", () => {
    expect(
      Server.globalEventOriginAllowed(
        "https://synergy.internal.example",
        "gopher://synergy.internal.example/global/event/ws",
      ),
    ).toBe(false)
  })
})

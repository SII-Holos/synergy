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

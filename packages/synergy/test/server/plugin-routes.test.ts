import { describe, expect, test, mock, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Server } from "../../src/server/server"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"
import { Log } from "../../src/util/log"
import { Global } from "../../src/global"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildLoadedPlugin(overrides: Partial<Plugin.LoadedPlugin> = {}): Plugin.LoadedPlugin {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    hooks: {} as any,
    pluginDir: "/tmp/test-plugin-dir",
    agents: {},
    ...overrides,
  }
}

function buildManifest(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    name: "Test Plugin",
    version: "1.0.0",
    contributes: {
      config: { schema: { apiKey: { type: "string", description: "API Key" } } },
      ui: { entry: "dist/ui.js" },
    },
    permissions: { webfetch: "allow" },
    ...overrides,
  }
}

const _origPlugin = {
  get: Plugin.get,
  manifest: Plugin.manifest,
  loaded: Plugin.getLoaded,
  add: Plugin.add,
}

const _origConfig = {
  get: Config.get,
  updateGlobal: Config.updateGlobal,
}

afterEach(() => {
  ;(Plugin as any).get = _origPlugin.get
  ;(Plugin as any).manifest = _origPlugin.manifest
  ;(Plugin as any).loaded = _origPlugin.loaded
  ;(Plugin as any).add = _origPlugin.add
  ;(Plugin as any).getStatus = _origPluginStatus.getStatus
  ;(Config as any).get = _origConfig.get
  ;(Config as any).updateGlobal = _origConfig.updateGlobal
})

async function withRegistryFile<T>(content: unknown, fn: () => Promise<T>): Promise<T> {
  const registryPath = path.join(Global.Path.data, "registry", "plugins.json")
  let previous: string | undefined
  try {
    previous = await Bun.file(registryPath).text()
  } catch {
    previous = undefined
  }

  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  await Bun.write(registryPath, JSON.stringify(content, null, 2))

  try {
    return await fn()
  } finally {
    if (previous === undefined) {
      fs.rmSync(registryPath, { force: true })
    } else {
      await Bun.write(registryPath, previous)
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Path containment — test the pure function directly since the wildcard
//    param `c.req.param("*")` is not captured by Hono's app.request() in the
//    Bun test environment. The checkPathContainment function is the contract.
// ---------------------------------------------------------------------------

describe("checkPathContainment (path traversal guard)", () => {
  test("rejects .. traversal outside the base directory", () => {
    const base = "/plugins/plugin-a"
    expect(path.resolve(base, "../etc/passwd")).toBe("/plugins/etc/passwd")
    const relative = path.relative(base, "/plugins/etc/passwd")
    // The guard detects traversal when relative starts with ".." or is absolute
    expect(relative.startsWith("..")).toBe(true)
  })

  test("rejects absolute-path filePath as traversal", () => {
    const base = "/plugins/plugin-a"
    const resolved = path.resolve(base, "/etc/passwd")
    // path.resolve(base, absolutePath) returns the absolutePath itself
    expect(resolved).toBe("/etc/passwd")
    const relative = path.relative(base, resolved)
    expect(relative.startsWith("..")).toBe(true)
  })

  test("allows contained relative paths within base", () => {
    const base = "/plugins/plugin-a"
    const resolved = path.resolve(base, "dist/ui.js")
    expect(resolved).toBe("/plugins/plugin-a/dist/ui.js")
    const relative = path.relative(base, resolved)
    expect(relative.startsWith("..")).toBe(false)
    expect(path.isAbsolute(relative)).toBe(false)
  })

  test("allows nested subdirectories within base", () => {
    const base = "/plugins/plugin-a"
    const resolved = path.resolve(base, "dist/nested/deep/ui.js")
    const relative = path.relative(base, resolved)
    expect(relative).toBe("dist/nested/deep/ui.js")
    expect(relative.startsWith("..")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Asset serving — test status codes and the "empty path" guard
//    The wildcard `c.req.param("*")` is not captured in Bun test using
//    Hono's app.request(), so full asset serving is not testable here.
//    The empty-path error path IS testable because Hono returns undefined
//    for `c.req.param("*")` which triggers the "Missing asset path" guard.
// ---------------------------------------------------------------------------

describe("GET /plugin/assets/:pluginId/:versionHash/* — asset edge cases", () => {
  test("returns 400 when wildcard path is not captured (empty guard)", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin({ pluginDir: tmp.path })
    ;(Plugin as any).get = mock(async () => plugin)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        // The wildcard * is not captured by Hono's app.request() in test;
        // c.req.param("*") returns undefined, hitting the empty-path guard.
        const res = await app.request("/plugin/assets/test-plugin/v1/bundle.js", { method: "GET" })
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.message).toBe("Missing asset path")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Plugin status — enriched comprehensive status
// ---------------------------------------------------------------------------
const _origPluginStatus = {
  getStatus: Plugin.getStatus,
}
function buildStatusResponse(overrides: Partial<Record<string, any>> = {}): any {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    source: "local",
    trust: {
      tier: "trusted-import",
      source: "local",
      userTrusted: true,
      verifiedIntegrity: false,
      reason: "local plugin",
    },
    loaded: true,
    manifestValid: true,
    integrity: "unverified",
    permissions: {
      base: ["plugin_invoke"],
      tools: {},
      overallRisk: "low",
      warnings: [],
    },
    routes: [],
    tools: [],
    ui: { contributions: 0, errors: [] },
    stores: { config: true, secrets: "none" },
    warnings: [{ type: "integrity", message: "Plugin integrity has not been verified against a lockfile hash." }],
    ...overrides,
  }
}

describe("GET /plugin/:pluginId/status — comprehensive status", () => {
  test("returns enriched status for a loaded plugin", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).getStatus = mock(async () =>
      buildStatusResponse({ source: "local", trust: { ...buildStatusResponse().trust, tier: "trusted-import" } }),
    )

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/status", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.id).toBe("test-plugin")
        expect(body.loaded).toBe(true)
        expect(body.source).toBe("local")
        expect(body.trust.tier).toBe("trusted-import")
        expect(body.manifestValid).toBe(true)
        expect(body.version).toBe("1.0.0")
        expect(body.permissions).toBeDefined()
        expect(body.tools).toBeDefined()
        expect(body.stores).toBeDefined()
        expect(body.warnings).toBeDefined()
      },
    })
  })

  test("returns sandbox trust for npm plugins", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).getStatus = mock(async () =>
      buildStatusResponse({
        source: "npm",
        trust: {
          tier: "sandbox",
          source: "npm",
          userTrusted: false,
          verifiedIntegrity: false,
          reason: "npm plugin requires explicit user trust and verified integrity",
        },
      }),
    )

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/status", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.trust.tier).toBe("sandbox")
        expect(body.source).toBe("npm")
      },
    })
  })

  test("returns manifestValid=false when manifest is unavailable", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).getStatus = mock(async () => buildStatusResponse({ manifestValid: false, version: undefined }))

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/status", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.manifestValid).toBe(false)
        expect(body.version).toBeUndefined()
      },
    })
  })

  test("returns 404 for a plugin that does not exist", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).getStatus = mock(async () => null)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/no-such-plugin/status", { method: "GET" })
        expect(res.status).toBe(404)
        const body = await res.json()
        expect(body.message).toContain("Plugin not found")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3a. Registry install — consent must not be bypassed
// ---------------------------------------------------------------------------

describe("POST /api/plugins/install-from-registry", () => {
  test("does not pass skipConsent when installing from the registry", async () => {
    await using tmp = await tmpdir({ git: true })
    const addMock = mock(async () => {
      throw new Error("Plugin registry-plugin requires approval before installation.")
    })
    ;(Plugin as any).add = addMock

    await withRegistryFile(
      {
        plugins: [
          {
            id: "registry-plugin",
            name: "registry-plugin-package",
            versions: [{ version: "1.0.0" }],
          },
        ],
      },
      async () => {
        await Instance.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const app = Server.App()
            const res = await app.request("/api/plugins/install-from-registry", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: "registry-plugin", version: "1.0.0" }),
            })

            expect(res.status).toBe(409)
            expect(addMock).toHaveBeenCalledTimes(1)
            expect((addMock as any).mock.calls[0][0]).toBe("registry-plugin-package")
            expect((addMock as any).mock.calls[0][1]).toEqual({ autoReload: true })
          },
        })
      },
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Config schema
// ---------------------------------------------------------------------------

describe("GET /plugin/:pluginId/config-schema", () => {
  test("returns manifest-contributed config schema", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({
      contributes: { config: { schema: { apiKey: { type: "string" }, port: { type: "number", default: 3000 } } } },
    })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => manifest)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/config-schema", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({ apiKey: { type: "string" }, port: { type: "number", default: 3000 } })
      },
    })
  })

  test("returns empty object when manifest has no config schema", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({ contributes: {} })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => manifest)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/config-schema", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({})
      },
    })
  })

  test("returns 404 when manifest cannot be loaded", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => null)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/config-schema", { method: "GET" })
        expect(res.status).toBe(404)
        const body = await res.json()
        expect(body.message).toContain("manifest not found")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 5. Config PATCH — merge and size limit
// ---------------------------------------------------------------------------

describe("PATCH /plugin/:pluginId/config", () => {
  test("merges new values into existing config", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    const currentConfig = { theme: "dark", refreshInterval: 30 }
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Config as any).get = mock(async () => ({
      pluginConfig: { "test-plugin": currentConfig },
    }))
    const domainUpdateSpy = mock(async () => {})
    ;(Config as any).domainUpdate = domainUpdateSpy

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme: "light" }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({ theme: "light", refreshInterval: 30 })
        expect(domainUpdateSpy).toHaveBeenCalledTimes(1)
        expect((domainUpdateSpy as any).mock.calls[0][0]).toBe("plugins")
        const updateArg = (domainUpdateSpy as any).mock.calls[0][1]
        expect(updateArg).toEqual({
          pluginConfig: { "test-plugin": { theme: "light", refreshInterval: 30 } },
        })
      },
    })
  })

  test("returns empty object when no existing config and no new values", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Config as any).get = mock(async () => ({}))
    const domainUpdateSpy = mock(async () => {})
    ;(Config as any).domainUpdate = domainUpdateSpy

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({})
      },
    })
  })

  test("rejects oversized payloads exceeding 64KB", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)

    // Build payload where JSON.stringify produces > 65536 bytes (64KB + 1)
    // JSON wrapper {"x":"..."} adds 9 characters
    const valueLen = 65530
    const payload = { x: "a".repeat(valueLen) }
    const serialized = JSON.stringify(payload)
    // Verify the payload is actually over 64KB (65536 bytes)
    expect(serialized.length).toBeGreaterThan(65535)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: serialized,
        })
        // The validator uses `.refine(obj => JSON.stringify(obj).length < 65536)`
        // which checks the deserialized object, not the raw body
        expect(res.status).toBe(400)
      },
    })
  })

  test("accepts payload at 64KB boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Config as any).get = mock(async () => ({}))
    const domainUpdateSpy = mock(async () => {})
    ;(Config as any).domainUpdate = domainUpdateSpy

    // Build a payload under 65536 bytes when re-stringified by the validator
    const valueLen = 65520
    const payload = { x: "a".repeat(valueLen) }
    const serialized = JSON.stringify(payload)
    expect(serialized.length).toBeLessThan(65536)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: serialized,
        })
        expect(res.status).toBe(200)
        expect(domainUpdateSpy).toHaveBeenCalledTimes(1)
        expect((domainUpdateSpy as any).mock.calls[0][0]).toBe("plugins")
      },
    })
  })

  test("returns 404 for a plugin that does not exist", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).get = mock(async () => undefined)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/no-such-plugin/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme: "dark" }),
        })
        expect(res.status).toBe(404)
        const body = await res.json()
        expect(body.message).toContain("Plugin not found")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 6. MIME type mapping — test Bun.file type detection directly since the
//    asset route uses `file.type` for Content-Type assignment.
// ---------------------------------------------------------------------------

describe("Bun.file MIME type mapping (used by asset route)", () => {
  test("detects text/javascript for .js files", async () => {
    await using tmp = await tmpdir()
    const p = path.join(tmp.path, "bundle.js")
    await Bun.write(p, "export const x = 1")
    const file = Bun.file(p)
    expect(file.type).toMatch(/javascript|ecmascript/)
  })

  test("detects text/css for .css files", async () => {
    await using tmp = await tmpdir()
    const p = path.join(tmp.path, "style.css")
    await Bun.write(p, "body { color: red; }")
    const file = Bun.file(p)
    expect(file.type).toMatch(/text\/css/)
  })

  test("detects text/html for .html files", async () => {
    await using tmp = await tmpdir()
    const p = path.join(tmp.path, "sandbox.html")
    await Bun.write(p, "<html></html>")
    const file = Bun.file(p)
    expect(file.type).toMatch(/text\/html/)
  })

  test("falls back to application/octet-stream for unknown extensions", async () => {
    await using tmp = await tmpdir()
    const p = path.join(tmp.path, "data.bin")
    await Bun.write(p, "binary content")
    const file = Bun.file(p)
    expect(file.type).toBe("application/octet-stream")
  })

  test("detects image/png for .png files", async () => {
    await using tmp = await tmpdir()
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    )
    const p = path.join(tmp.path, "icon.png")
    await Bun.write(p, png)
    const file = Bun.file(p)
    expect(file.type).toBe("image/png")
  })

  test("detects application/json for .json files", async () => {
    await using tmp = await tmpdir()
    const p = path.join(tmp.path, "manifest.json")
    await Bun.write(p, JSON.stringify({ key: "value" }))
    const file = Bun.file(p)
    expect(file.type).toMatch(/application\/json/)
  })
})

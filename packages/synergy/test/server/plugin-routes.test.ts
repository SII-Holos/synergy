import { describe, expect, test, mock, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"
import { Log } from "../../src/util/log"
import { Global } from "../../src/global"
import { baseCapabilities } from "../../src/plugin/capability"
import {
  computeManifestHash,
  computePermissionsHash,
  removeApproval,
  saveApproval,
} from "../../src/plugin/consent/approval-store"
import { checkPathContainment } from "../../src/util/path-contain"

Log.init({ print: false })
const { PluginMarketplaceRegistry } = await import("../../src/plugin/marketplace-registry")

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildLoadedPlugin(overrides: Partial<Plugin.LoadedPlugin> = {}): Plugin.LoadedPlugin {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    hooks: {} as any,
    manifest: buildManifest() as any,
    pluginDir: "/tmp/test-plugin-dir",
    agents: {},
    ...overrides,
  }
}

function buildManifest(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    name: "test-plugin",
    version: "1.0.0",
    contributes: {
      config: {
        schema: {
          type: "object",
          properties: {
            apiKey: { type: "string", description: "API Key" },
          },
          additionalProperties: true,
        },
      },
      ui: { entry: "dist/ui.js" },
    },
    permissions: { webfetch: "allow" },
    ...overrides,
  }
}

const _origPlugin = {
  get: Plugin.get,
  manifest: Plugin.manifest,
  getLoaded: Plugin.getLoaded,
  getDisabled: Plugin.getDisabled,
  getDisabledPlugin: Plugin.getDisabledPlugin,
  add: Plugin.add,
  remove: Plugin.remove,
}

const _origConfig = {
  current: Config.current,
  domainGet: Config.domainGet,
  domainUpdate: Config.domainUpdate,
  updateGlobal: Config.updateGlobal,
}

const _origMarketplaceRegistry = {
  verifyOfficialArtifact: PluginMarketplaceRegistry.verifyOfficialArtifact,
}

afterEach(() => {
  ;(Plugin as any).get = _origPlugin.get
  ;(Plugin as any).manifest = _origPlugin.manifest
  ;(Plugin as any).getLoaded = _origPlugin.getLoaded
  ;(Plugin as any).getDisabled = _origPlugin.getDisabled
  ;(Plugin as any).getDisabledPlugin = _origPlugin.getDisabledPlugin
  ;(Plugin as any).add = _origPlugin.add
  ;(Plugin as any).remove = _origPlugin.remove
  ;(Plugin as any).getStatus = _origPluginStatus.getStatus
  ;(Config as any).current = _origConfig.current
  ;(Config as any).domainGet = _origConfig.domainGet
  ;(Config as any).domainUpdate = _origConfig.domainUpdate
  ;(Config as any).updateGlobal = _origConfig.updateGlobal
  ;(PluginMarketplaceRegistry as any).verifyOfficialArtifact = _origMarketplaceRegistry.verifyOfficialArtifact
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
    const base = path.join(path.parse(process.cwd()).root, "plugins", "plugin-a")
    expect(checkPathContainment(base, "../etc/passwd")).toBeNull()
  })

  test("rejects absolute-path filePath as traversal", () => {
    const base = path.join(path.parse(process.cwd()).root, "plugins", "plugin-a")
    const outside = path.join(path.parse(process.cwd()).root, "etc", "passwd")
    expect(checkPathContainment(base, outside)).toBeNull()
  })

  test("rejects absolute sibling-prefix paths", () => {
    const base = path.join(path.parse(process.cwd()).root, "plugins", "plugin-a")
    const sibling = path.join(path.parse(process.cwd()).root, "plugins", "plugin-a-other", "dist", "ui.js")
    expect(checkPathContainment(base, sibling)).toBeNull()
  })

  test("allows contained relative paths within base", () => {
    const base = path.join(path.parse(process.cwd()).root, "plugins", "plugin-a")
    expect(checkPathContainment(base, "dist/ui.js")).toBe(path.join(base, "dist", "ui.js"))
  })

  test("allows the base directory itself", () => {
    const base = path.join(path.parse(process.cwd()).root, "plugins", "plugin-a")
    expect(checkPathContainment(base, ".")).toBe(base)
  })

  test("allows nested subdirectories within base", () => {
    const base = path.join(path.parse(process.cwd()).root, "plugins", "plugin-a")
    expect(checkPathContainment(base, "dist/nested/deep/ui.js")).toBe(
      path.join(base, "dist", "nested", "deep", "ui.js"),
    )
  })

  test("allows contained names that begin with two dots", () => {
    const base = path.join(path.parse(process.cwd()).root, "plugins", "plugin-a")
    expect(checkPathContainment(base, "..cache/ui.js")).toBe(path.join(base, "..cache", "ui.js"))
  })

  test("rejects Windows cross-drive paths", () => {
    if (process.platform !== "win32") return
    expect(checkPathContainment("C:\\plugins\\plugin-a", "D:\\plugins\\plugin-a\\dist\\ui.js")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Asset serving
// ---------------------------------------------------------------------------

describe("GET /plugin/assets/:pluginId/:versionHash/* — asset edge cases", () => {
  test("serves nested plugin assets", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin({ pluginDir: tmp.path })
    ;(Plugin as any).get = mock(async () => plugin)
    const asset = path.join(tmp.path, "dist", "ui", "index.js")
    fs.mkdirSync(path.dirname(asset), { recursive: true })
    await Bun.write(asset, "export const value = 1\n")

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/assets/test-plugin/v1/dist/ui/index.js", { method: "GET" })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("text/javascript")
        expect(res.headers.get("cache-control")).toBe("public, immutable, max-age=31536000")
        expect(await res.text()).toBe("export const value = 1\n")
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
    health: "loaded",
    loaded: true,
    manifestValid: true,
    integrity: "unverified",
    permissions: {
      base: [],
      tools: {},
      overallRisk: "low",
      warnings: [],
    },
    navigation: [],
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

    await ScopeContext.provide({
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

    await ScopeContext.provide({
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

    await ScopeContext.provide({
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

    await ScopeContext.provide({
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
// 4. Plugin removal — uninstall route
// ---------------------------------------------------------------------------

describe("DELETE /api/plugins/:pluginId", () => {
  test("removes a loaded plugin", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).get = mock(async () => buildLoadedPlugin({ id: "remove-me", pluginDir: tmp.path }))
    ;(Plugin as any).remove = mock(async () => undefined)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/remove-me", { method: "DELETE" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({ pluginId: "remove-me", removed: true })
        expect(Plugin.remove).toHaveBeenCalledWith("remove-me", { autoReload: true })
      },
    })
  })

  test("returns 404 when plugin is not installed", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).get = mock(async () => null)
    ;(Plugin as any).remove = mock(async () => undefined)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/missing-plugin", { method: "DELETE" })
        expect(res.status).toBe(404)
        const body = await res.json()
        expect(body.message).toBe("Plugin not found: missing-plugin")
        expect(Plugin.remove).not.toHaveBeenCalled()
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3a. Registry install — consent must not be bypassed
// ---------------------------------------------------------------------------

describe("POST /api/plugins/install-from-registry", () => {
  test("does not pass skipConsent when installing an explicit local installSpec", async () => {
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
            versions: [{ version: "1.0.0", installSpec: "registry-plugin-package" }],
          },
        ],
      },
      async () => {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const app = Server.App()
            const res = await app.request("/api/plugins/install-from-registry", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: "registry-plugin", version: "1.0.0", source: "local" }),
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

  test("rejects local registry versions without an explicit artifact or install spec", async () => {
    await using tmp = await tmpdir({ git: true })
    const addMock = mock(async () => buildLoadedPlugin({ id: "registry-plugin", pluginDir: tmp.path }))
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
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const app = Server.App()
            const res = await app.request("/api/plugins/install-from-registry", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: "registry-plugin", version: "1.0.0", source: "local" }),
            })

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.message).toContain("versions[].downloadUrl or versions[].installSpec")
            expect(addMock).not.toHaveBeenCalled()
          },
        })
      },
    )
  })

  test("installs registry versions from their published tarball downloadUrl", async () => {
    await using tmp = await tmpdir({ git: true })
    const addMock = mock(async () =>
      buildLoadedPlugin({ id: "registry-plugin", name: "Registry Plugin", pluginDir: tmp.path }),
    )
    ;(Plugin as any).add = addMock
    ;(Plugin as any).manifest = mock(async () => ({ name: "registry-plugin", version: "1.0.0" }))

    await withRegistryFile(
      {
        plugins: [
          {
            id: "registry-plugin",
            name: "registry-plugin-package",
            versions: [
              {
                version: "1.0.0",
                downloadUrl: "file:///tmp/registry-plugin-1.0.0.synergy-plugin.tgz",
                integrity: "sha256-test",
              },
            ],
          },
        ],
      },
      async () => {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const app = Server.App()
            const res = await app.request("/api/plugins/install-from-registry", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: "registry-plugin", version: "1.0.0", source: "local" }),
            })

            expect(res.status).toBe(200)
            expect(addMock).toHaveBeenCalledTimes(1)
            expect((addMock as any).mock.calls[0][0]).toBe("file:///tmp/registry-plugin-1.0.0.synergy-plugin.tgz")
            expect((addMock as any).mock.calls[0][1]).toEqual({ autoReload: true })
          },
        })
      },
    )
  })

  test("defaults to the official registry and does not fall back to local entries", async () => {
    await using tmp = await tmpdir({ git: true })
    const addMock = mock(async () => buildLoadedPlugin({ id: "registry-plugin", pluginDir: tmp.path }))
    const officialMock = mock(async () => {
      throw new Error("Official registry plugin not found: registry-plugin")
    })
    ;(Plugin as any).add = addMock
    ;(PluginMarketplaceRegistry as any).verifyOfficialArtifact = officialMock

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
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const app = Server.App()
            const res = await app.request("/api/plugins/install-from-registry", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: "registry-plugin", version: "1.0.0" }),
            })

            expect(res.status).toBe(404)
            expect(officialMock).toHaveBeenCalledTimes(1)
            expect(addMock).not.toHaveBeenCalled()
          },
        })
      },
    )
  })

  test("preserves official source when installing a verified official artifact", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = { name: "registry-plugin", version: "1.0.0" }
    const capabilities = baseCapabilities(manifest as any)
    const addMock = mock(async () =>
      buildLoadedPlugin({ id: "registry-plugin", name: "Registry Plugin", pluginDir: tmp.path, source: "official" }),
    )
    const officialMock = mock(async () => ({
      manifest,
      capabilities,
      risk: "low",
      tarballPath: path.join(tmp.path, "registry-plugin-1.0.0.synergy-plugin.tgz"),
      cacheKey: "official:registry-plugin@1.0.0:test",
    }))
    ;(Plugin as any).add = addMock
    ;(Plugin as any).manifest = mock(async () => manifest)
    ;(PluginMarketplaceRegistry as any).verifyOfficialArtifact = officialMock

    await saveApproval({
      pluginId: "registry-plugin",
      source: "official",
      version: "1.0.0",
      manifestHash: computeManifestHash(manifest as any),
      permissionsHash: computePermissionsHash(manifest as any, capabilities),
      approvedAt: Date.now(),
      approvedBy: "user",
      trustTier: "trusted-import",
      approvedCapabilities: capabilities,
      approvedNetworkDomains: [],
      approvedUISurfaces: [],
      risk: "low",
    })

    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const app = Server.App()
          const res = await app.request("/api/plugins/install-from-registry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "registry-plugin", version: "1.0.0" }),
          })

          expect(res.status).toBe(200)
          expect(officialMock).toHaveBeenCalledTimes(1)
          expect(addMock).toHaveBeenCalledTimes(1)
          expect((addMock as any).mock.calls[0][0]).toBe(
            pathToFileURL(path.join(tmp.path, "registry-plugin-1.0.0.synergy-plugin.tgz")).toString(),
          )
          expect((addMock as any).mock.calls[0][1]).toEqual({
            autoReload: true,
            skipConsent: true,
            source: "official",
          })
        },
      })
    } finally {
      await removeApproval("registry-plugin")
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Plugin aggregate APIs tolerate disabled plugins
// ---------------------------------------------------------------------------

describe("plugin aggregate routes", () => {
  test("GET /api/plugins returns loaded plugins and disabled diagnostics", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin({
      id: "loaded-plugin",
      name: "Loaded Plugin",
      manifest: buildManifest({ name: "loaded-plugin", version: "1.2.3", contributes: {} }) as any,
      pluginDir: tmp.path,
    })
    ;(Plugin as any).getLoaded = mock(async () => [plugin])
    ;(Plugin as any).getDisabled = mock(async () => [
      {
        pluginId: "disabled-plugin",
        name: "Disabled Plugin",
        pluginDir: path.join(tmp.path, "missing-plugin"),
        phase: "manifest",
        reason: "Plugin manifest not found",
        disabledAt: Date.now(),
      },
    ])

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.find((entry: any) => entry.pluginId === "loaded-plugin")?.health).toBe("loaded")
        const disabled = body.find((entry: any) => entry.pluginId === "disabled-plugin")
        expect(disabled).toMatchObject({
          health: "disabled",
          loaded: false,
          hasManifest: false,
          disabledReason: "Plugin manifest not found",
          disabledPhase: "manifest",
          capabilities: [],
          cliCommands: [],
        })
      },
    })
  })

  test("GET /plugin/ui/contributions returns disabled plugin diagnostics", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin({
      id: "ui-plugin",
      name: "UI Plugin",
      manifest: buildManifest({
        name: "ui-plugin",
        version: "2.0.0",
        contributes: { ui: { entry: "dist/ui.js" } },
      }) as any,
      pluginDir: tmp.path,
    })
    ;(Plugin as any).getLoaded = mock(async () => [plugin])
    ;(Plugin as any).getDisabled = mock(async () => [
      {
        pluginId: "disabled-ui-plugin",
        name: "Disabled UI Plugin",
        phase: "load",
        reason: "Plugin load failed",
        disabledAt: Date.now(),
      },
    ])

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/ui/contributions", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.find((entry: any) => entry.pluginId === "ui-plugin")?.health).toBe("loaded")
        const disabled = body.find((entry: any) => entry.pluginId === "disabled-ui-plugin")
        expect(disabled).toMatchObject({
          health: "disabled",
          disabledReason: "Plugin load failed",
          disabledPhase: "load",
          ui: null,
          permissions: null,
        })
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 5. Config schema
// ---------------------------------------------------------------------------

describe("GET /plugin/:pluginId/config-schema", () => {
  test("returns manifest-contributed config schema", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({
      contributes: {
        config: {
          schema: {
            type: "object",
            properties: {
              apiKey: { type: "string" },
              port: { type: "number", default: 3000 },
            },
            additionalProperties: false,
          },
        },
      },
    })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => manifest)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/config-schema", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({
          type: "object",
          properties: {
            apiKey: { type: "string" },
            port: { type: "number", default: 3000 },
          },
          additionalProperties: false,
        })
      },
    })
  })

  test("returns empty object when manifest has no config schema", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({ contributes: {} })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => manifest)

    await ScopeContext.provide({
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

    await ScopeContext.provide({
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
// 5. Config PATCH — replacement, schema validation, and size limit
// ---------------------------------------------------------------------------

describe("PATCH /plugin/:pluginId/config", () => {
  test("replaces the plugin config namespace", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    const currentConfig = { theme: "dark", refreshInterval: 30 }
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () =>
      buildManifest({
        contributes: {
          config: {
            schema: {
              type: "object",
              properties: { theme: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      }),
    )
    ;(Config as any).domainGet = mock(async () => ({
      plugin: ["existing-spec"],
      pluginMarketplace: { enabled: true },
      pluginConfig: { "test-plugin": currentConfig },
    }))
    const domainUpdateSpy = mock(async () => {})
    ;(Config as any).domainUpdate = domainUpdateSpy

    await ScopeContext.provide({
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
        expect(body).toEqual({ theme: "light" })
        expect(domainUpdateSpy).toHaveBeenCalledTimes(1)
        expect((domainUpdateSpy as any).mock.calls[0][0]).toBe("plugins")
        const updateArg = (domainUpdateSpy as any).mock.calls[0][1]
        expect(updateArg).toEqual({
          plugin: ["existing-spec"],
          pluginMarketplace: { enabled: true },
          pluginConfig: { "test-plugin": { theme: "light" } },
        })
        expect((domainUpdateSpy as any).mock.calls[0][2]).toEqual({ mode: "replace-domain" })
      },
    })
  })

  test("returns empty object when no existing config and no new values", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => buildManifest())
    ;(Config as any).domainGet = mock(async () => ({}))
    const domainUpdateSpy = mock(async () => {})
    ;(Config as any).domainUpdate = domainUpdateSpy

    await ScopeContext.provide({
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
        expect(domainUpdateSpy).toHaveBeenCalledTimes(1)
      },
    })
  })

  test("rejects values that do not match contributes.config.schema", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () =>
      buildManifest({
        contributes: {
          config: {
            schema: {
              type: "object",
              properties: { refreshInterval: { type: "number" } },
              additionalProperties: false,
            },
          },
        },
      }),
    )
    ;(Config as any).domainGet = mock(async () => ({ pluginConfig: { "test-plugin": { refreshInterval: 30 } } }))
    const domainUpdateSpy = mock(async () => {})
    ;(Config as any).domainUpdate = domainUpdateSpy

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/plugin/test-plugin/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshInterval: "fast" }),
        })
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.message).toContain("contributes.config.schema")
        expect(domainUpdateSpy).not.toHaveBeenCalled()
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

    await ScopeContext.provide({
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
    ;(Plugin as any).manifest = mock(async () => buildManifest())
    ;(Config as any).domainGet = mock(async () => ({}))
    const domainUpdateSpy = mock(async () => {})
    ;(Config as any).domainUpdate = domainUpdateSpy

    // Build a payload under 65536 bytes when re-stringified by the validator
    const valueLen = 65520
    const payload = { x: "a".repeat(valueLen) }
    const serialized = JSON.stringify(payload)
    expect(serialized.length).toBeLessThan(65536)

    await ScopeContext.provide({
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

    await ScopeContext.provide({
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

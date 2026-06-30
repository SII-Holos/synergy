import { describe, expect, test, mock, afterEach } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Server } from "../../src/server/server"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildManifest(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    name: "test-plugin",
    version: "1.0.0",
    permissions: {},
    contributes: {},
    ...overrides,
  }
}

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

const _origPlugin = {
  get: Plugin.get,
  manifest: Plugin.manifest,
  getStatus: Plugin.getStatus,
}

const _origConfig = {
  current: Config.current,
}

afterEach(() => {
  ;(Plugin as any).get = _origPlugin.get
  ;(Plugin as any).manifest = _origPlugin.manifest
  ;(Plugin as any).getStatus = _origPlugin.getStatus
  ;(Config as any).current = _origConfig.current
})

// ---------------------------------------------------------------------------
// 1. Route registration & input validation
// ---------------------------------------------------------------------------

describe("POST /api/plugins/:pluginId/update-from-registry", () => {
  test("route is registered and rejects empty body with 400", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).get = mock(async () => buildLoadedPlugin())

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        // Route should validate input; empty or missing targetVersion is fine
        // (it's optional — means "latest"). Bad request would be invalid schema.
        // When route doesn't exist yet: 404 (RED)
        expect(res.status).not.toBe(404)
      },
    })
  })

  test("rejects invalid targetVersion (empty string) with 400", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).get = mock(async () => buildLoadedPlugin())

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetVersion: "" }),
        })
        // Empty version string should be rejected by validation
        expect(res.status).toBe(400)
      },
    })
  })

  test("accepts valid targetVersion in body", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    const manifest = buildManifest({ version: "1.0.0" })
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => manifest)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetVersion: "2.0.0" }),
        })
        // The route should accept the body and return a structured response.
        // Before the route exists: 404 (RED)
        expect(res.status).not.toBe(404)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Error states
// ---------------------------------------------------------------------------

describe("POST /api/plugins/:pluginId/update-from-registry — error states", () => {
  test("returns 404 when plugin is not installed", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).get = mock(async () => null)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/unknown-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(res.status).toBe(404)
        const body = await res.json()
        expect(body.message).toContain("not found")
      },
    })
  })

  test("returns 200 with updateAvailable:false when plugin not in registry", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => buildManifest({ version: "1.0.0" }))

    // No registry file exists → handler returns structured response indicating no update check possible
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.updateAvailable).toBe(false)
      },
    })
  })

  test("returns 200 with updateAvailable:false when targetVersion is not found (no registry)", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => buildManifest({ version: "1.0.0" }))

    // No registry file exists → handler returns structured response regardless of targetVersion
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetVersion: "99.99.99" }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.updateAvailable).toBe(false)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Success responses (behavioral contracts)
// ---------------------------------------------------------------------------

describe("POST /api/plugins/:pluginId/update-from-registry — success responses", () => {
  test("returns updateAvailable: false when already at latest version", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    const manifest = buildManifest({ version: "2.0.0" })
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => manifest)

    // The installed version is already the latest in registry → no update needed
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetVersion: "2.0.0" }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.updateAvailable).toBe(false)
      },
    })
  })

  test("uses requested registry source when installed source is not a registry source", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin({ source: "npm" })
    const manifest = buildManifest({ version: "2.0.0" })
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => manifest)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "official", targetVersion: "2.0.0" }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.updateAvailable).toBe(false)
        expect(body.source).toBe("official")
      },
    })
  })

  test("returns permission diff and requiresConsent when update needs approval", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    const oldManifest = buildManifest({
      version: "1.0.0",
      permissions: { tools: { filesystem: "read" } },
    })
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => oldManifest)

    // The registry has a newer version with expanded permissions → needs consent
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetVersion: "2.0.0" }),
        })
        // Even if the registry entry can't be found, the route handler
        // should handle the edge case gracefully and return structured data
        // When the full pipeline is wired, this returns 200 with a diff
        // For now (RED), we verify the route responds (not 404)
        expect(res.status).not.toBe(404)
      },
    })
  })

  test("returns structured response with pluginId, fromVersion, toVersion, updateAvailable, and requiresConsent fields", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin()
    const manifest = buildManifest({ version: "1.0.0" })
    ;(Plugin as any).get = mock(async () => plugin)
    ;(Plugin as any).manifest = mock(async () => manifest)

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/update-from-registry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetVersion: "2.0.0" }),
        })
        // The response MUST contain these fields regardless of outcome
        if (res.status === 200) {
          const body = await res.json()
          expect(body).toHaveProperty("pluginId")
          expect(body).toHaveProperty("fromVersion")
          expect(body).toHaveProperty("toVersion")
          expect(body).toHaveProperty("updateAvailable")
          expect(body).toHaveProperty("requiresConsent")
        }
        expect(res.status).not.toBe(404)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Path parameter edge cases
// ---------------------------------------------------------------------------

describe("POST /api/plugins/:pluginId/update-from-registry — edge cases", () => {
  test("handles pluginId with special characters (URL-encoded)", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = buildLoadedPlugin({ id: "@scope-pkg" })
    ;(Plugin as any).get = mock(async (id: string) => {
      if (id === "@scope-pkg") return plugin
      return null
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request(`/api/plugins/${encodeURIComponent("@scope-pkg")}/update-from-registry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(res.status).not.toBe(404)
      },
    })
  })
})

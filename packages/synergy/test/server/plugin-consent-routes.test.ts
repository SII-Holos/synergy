import { describe, expect, test, mock, afterEach } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Server } from "../../src/server/server"
import { Plugin } from "../../src/plugin"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildManifest(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    name: "test-plugin",
    version: "1.0.0",
    ...overrides,
  }
}

const _origPlugin = {
  get: Plugin.get,
  manifest: Plugin.manifest,
  loaded: Plugin.getLoaded,
}

afterEach(() => {
  ;(Plugin as any).get = _origPlugin.get
  ;(Plugin as any).manifest = _origPlugin.manifest
  ;(Plugin as any).loaded = _origPlugin.loaded
})

// ---------------------------------------------------------------------------
// 1. POST /api/plugins/preview-install
// ---------------------------------------------------------------------------

describe("POST /api/plugins/preview-install", () => {
  test("returns permission diff for a new plugin manifest", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({
      name: "new-plugin",
      version: "2.0.0",
      permissions: {
        tools: { shell: true, network: true },
        network: { connectDomains: ["api.example.com"] },
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/preview-install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifest }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.pluginId).toBe("new-plugin")
        expect(body.toVersion).toBe("2.0.0")
        expect(body.fromVersion).toBeUndefined()
        expect(body.requiresApproval).toBe(true)
        expect(body.added.length).toBeGreaterThan(0)
        expect(body.removed.length).toBe(0)
      },
    })
  })

  test("returns low risk for manifest with no permissions", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({ name: "safe-plugin", version: "1.0.0" })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/preview-install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifest }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.riskAfter).toBe("low")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 2. POST /api/plugins/:pluginId/approve-install
// ---------------------------------------------------------------------------

describe("POST /api/plugins/:pluginId/approve-install", () => {
  test("creates and returns an approval record", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({
      name: "installed-plugin",
      version: "1.0.0",
      permissions: { tools: { filesystem: "read" } },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/approve-install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifest,
            capabilities: ["plugin_invoke", "filesystem:read"],
          }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.pluginId).toBe("test-plugin")
        expect(body.approvedBy).toBe("user")
        expect(body.version).toBe("1.0.0")
        expect(body.approvedCapabilities).toContain("filesystem:read")
        expect(body.approvedAt).toBeGreaterThan(0)
        expect(body.manifestHash).toBeDefined()
        expect(body.permissionsHash).toBeDefined()
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3. POST /api/plugins/:pluginId/preview-update
// ---------------------------------------------------------------------------

describe("POST /api/plugins/:pluginId/preview-update", () => {
  test("returns diff between current and new manifest", async () => {
    await using tmp = await tmpdir({ git: true })
    const oldManifest = buildManifest({
      name: "test-plugin",
      version: "1.0.0",
      permissions: { tools: { filesystem: "read" } },
    })
    const newManifest = buildManifest({
      name: "test-plugin",
      version: "2.0.0",
      permissions: { tools: { filesystem: "write", shell: true } },
    })
    ;(Plugin as any).manifest = mock(async () => oldManifest)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/preview-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifest: newManifest }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.pluginId).toBe("test-plugin")
        expect(body.fromVersion).toBe("1.0.0")
        expect(body.toVersion).toBe("2.0.0")
        expect(body.requiresApproval).toBe(true)
        expect(body.added.length).toBeGreaterThan(0)
      },
    })
  })

  test("returns 404 when plugin has no manifest", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).manifest = mock(async () => null)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/unknown-plugin/preview-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifest: buildManifest() }),
        })
        expect(res.status).toBe(404)
        const body = await res.json()
        expect(body.message).toContain("not found")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 4. POST /api/plugins/:pluginId/approve-update
// ---------------------------------------------------------------------------

describe("POST /api/plugins/:pluginId/approve-update", () => {
  test("creates and returns an approval record (overwrites previous)", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({
      name: "updated-plugin",
      version: "2.0.0",
      permissions: { tools: { network: true } },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/test-plugin/approve-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifest,
            capabilities: ["plugin_invoke", "network"],
          }),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.pluginId).toBe("test-plugin")
        expect(body.version).toBe("2.0.0")
        expect(body.risk).toBe("high") // network without domains
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 5. GET /api/plugins/:pluginId/approval
// ---------------------------------------------------------------------------

describe("GET /api/plugins/:pluginId/approval", () => {
  test("returns approval record for an approved plugin", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({
      name: "approved-plugin",
      version: "1.0.0",
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        // First, create the approval
        await app.request("/api/plugins/test-plugin/approve-install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifest,
            capabilities: ["plugin_invoke"],
          }),
        })
        // Then, retrieve it
        const res = await app.request("/api/plugins/test-plugin/approval", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.pluginId).toBe("test-plugin")
        expect(body.approvedBy).toBe("user")
      },
    })
  })

  test("returns 404 when no approval exists", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/never-approved/approval", { method: "GET" })
        expect(res.status).toBe(404)
        const body = await res.json()
        expect(body.message).toContain("No approval record")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 6. GET /api/plugins/:pluginId/permission-diff
// ---------------------------------------------------------------------------

describe("GET /api/plugins/:pluginId/permission-diff", () => {
  test("returns diff between approved caps and current manifest", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({
      name: "diff-plugin",
      version: "1.0.0",
      permissions: { tools: { filesystem: "read" } },
    })
    ;(Plugin as any).manifest = mock(async () => manifest)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        // Approve with just plugin_invoke (less than current manifest provides)
        await app.request("/api/plugins/diff-plugin/approve-install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifest,
            capabilities: ["plugin_invoke"],
          }),
        })
        const res = await app.request("/api/plugins/diff-plugin/permission-diff", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.pluginId).toBe("diff-plugin")
        expect(body.added.length).toBeGreaterThan(0) // filesystem:read added vs approved
      },
    })
  })

  test("returns full diff as new install when no approval exists", async () => {
    await using tmp = await tmpdir({ git: true })
    const manifest = buildManifest({
      name: "no-approval-plugin",
      version: "1.0.0",
    })
    ;(Plugin as any).manifest = mock(async () => manifest)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/no-approval-plugin/permission-diff", { method: "GET" })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.pluginId).toBe("no-approval-plugin")
        expect(body.fromVersion).toBeUndefined()
      },
    })
  })

  test("returns 404 when plugin has no manifest", async () => {
    await using tmp = await tmpdir({ git: true })
    ;(Plugin as any).manifest = mock(async () => null)

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/plugins/nonexistent/permission-diff", { method: "GET" })
        expect(res.status).toBe(404)
        const body = await res.json()
        expect(body.message).toContain("not found")
      },
    })
  })
})

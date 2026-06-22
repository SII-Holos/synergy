import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/scope/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import path from "path"
import fs from "fs"
import { Global } from "../../src/global"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function registryStorePath(): string {
  return path.join(Global.Path.data, "registry")
}

function registryFilePath(): string {
  return path.join(registryStorePath(), "plugins.json")
}

function buildEntry(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    description: "A test plugin for registry v2",
    author: { name: "Test Author", email: "author@test.dev" },
    verified: false,
    official: false,
    keywords: ["test", "v2"],
    compatibility: { synergy: ">=1.0.0" },
    versions: [
      {
        version: "1.0.0",
        manifestHash: "abc123",
        permissionsHash: "def456",
        integrity: "sha256-xxx",
        risk: "low",
        permissionsSummary: [{ key: "plugin_invoke", description: "Run plugin", risk: "low" }],
        publishedAt: 1700000000000,
      },
    ],
    risk: "low",
    trustTier: "declarative",
    runtimeMode: "in-process",
    permissionsSummary: [
      {
        key: "plugin_invoke",
        category: "runtime",
        severity: "low",
        title: "Invoke plugin",
        description: "Basic plugin execution",
      },
    ],
    uiSurfaces: ["toolRenderers"],
    tools: ["myTool"],
    downloads: 0,
    ...overrides,
  }
}

async function setupDownloadFile(entryId: string, version: string): Promise<string> {
  const dir = path.join(registryStorePath(), entryId)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${version}.tar.gz`)
  await Bun.write(filePath, "fake-plugin-archive-content")
  return filePath
}

async function cleanRegistry(): Promise<void> {
  const registryPath = registryFilePath()
  try {
    fs.rmSync(registryPath, { force: true })
  } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plugin registry routes v2", () => {
  test("publish creates a new entry with v2 metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    cleanRegistry()

    const entry = buildEntry()

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/registry/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.id).toBe("test-plugin")
        expect(body.risk).toBe("low")
        expect(body.trustTier).toBe("declarative")
        expect(body.runtimeMode).toBe("in-process")
        expect(body.uiSurfaces).toEqual(["toolRenderers"])
        expect(body.tools).toEqual(["myTool"])
        expect(body.downloads).toBe(0)
        expect(body.permissionsSummary).toEqual([
          {
            key: "plugin_invoke",
            category: "runtime",
            severity: "low",
            title: "Invoke plugin",
            description: "Basic plugin execution",
          },
        ])
        expect(body.createdAt).toBeDefined()
        expect(body.updatedAt).toBeDefined()
      },
    })
  })

  test("publish updates existing entry and preserves v2 fields", async () => {
    await using tmp = await tmpdir({ git: true })
    cleanRegistry()

    const entry = buildEntry()

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        // First publish
        await app.request("/api/registry/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        })

        // Second publish with updated v2 fields
        const updated = buildEntry({
          description: "Updated description",
          risk: "medium",
          trustTier: "trusted-import",
          uiSurfaces: ["toolRenderers", "settings"],
          tools: ["myTool", "otherTool"],
          downloads: 5,
        })

        const res = await app.request("/api/registry/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updated),
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.description).toBe("Updated description")
        expect(body.risk).toBe("medium")
        expect(body.trustTier).toBe("trusted-import")
        expect(body.uiSurfaces).toEqual(["toolRenderers", "settings"])
        expect(body.tools).toEqual(["myTool", "otherTool"])
        expect(body.downloads).toBe(5)
        // Versions array gets updated
        expect(body.versions.length).toBe(1)
      },
    })
  })

  test("detail API returns full v2 metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    cleanRegistry()

    const entry = buildEntry({ rating: 4.5, ratingCount: 10, changelog: "Initial release" })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        await app.request("/api/registry/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        })

        const res = await app.request("/api/registry/test-plugin")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.id).toBe("test-plugin")
        expect(body.risk).toBe("low")
        expect(body.trustTier).toBe("declarative")
        expect(body.runtimeMode).toBe("in-process")
        expect(body.permissionsSummary).toEqual([
          {
            key: "plugin_invoke",
            category: "runtime",
            severity: "low",
            title: "Invoke plugin",
            description: "Basic plugin execution",
          },
        ])
        expect(body.uiSurfaces).toEqual(["toolRenderers"])
        expect(body.tools).toEqual(["myTool"])
        expect(body.downloads).toBe(0)
        expect(body.rating).toBe(4.5)
        expect(body.ratingCount).toBe(10)
        expect(body.changelog).toBe("Initial release")
      },
    })
  })

  test("search results include v2 metadata fields", async () => {
    await using tmp = await tmpdir({ git: true })
    cleanRegistry()

    const entry = buildEntry({ name: "SearchablePlugin", description: "Find me", keywords: ["searchable"] })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        await app.request("/api/registry/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        })

        const res = await app.request("/api/registry/search?q=Searchable")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.total).toBe(1)
        const summary = body.plugins[0]
        expect(summary.id).toBe("test-plugin")
        expect(summary.name).toBe("SearchablePlugin")
        expect(summary.risk).toBe("low")
        expect(summary.trustTier).toBe("declarative")
        expect(summary.runtimeMode).toBe("in-process")
        expect(summary.uiSurfaces).toEqual(["toolRenderers"])
        expect(summary.tools).toEqual(["myTool"])
        expect(summary.downloads).toBe(0)
      },
    })
  })

  test("search returns empty result without v2 fields for empty registry", async () => {
    await using tmp = await tmpdir({ git: true })
    cleanRegistry()

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/registry/search?q=nonexistent")
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.total).toBe(0)
        expect(body.plugins).toEqual([])
      },
    })
  })

  test("detail returns 404 for non-existent plugin", async () => {
    await using tmp = await tmpdir({ git: true })
    cleanRegistry()

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()
        const res = await app.request("/api/registry/nonexistent")
        expect(res.status).toBe(404)
      },
    })
  })

  test("download increments the download counter", async () => {
    await using tmp = await tmpdir({ git: true })
    cleanRegistry()

    // Create the download file
    await setupDownloadFile("test-plugin", "1.0.0")
    const storeRoot = registryStorePath()
    const downloadUrl = `file://${storeRoot}/test-plugin/1.0.0.tar.gz`

    const entry = buildEntry({
      versions: [
        {
          version: "1.0.0",
          manifestHash: "abc123",
          permissionsHash: "def456",
          integrity: "sha256-xxx",
          risk: "low",
          permissionsSummary: [{ key: "plugin_invoke", description: "Run plugin", risk: "low" }],
          publishedAt: 1700000000000,
          downloadUrl,
        },
      ],
      downloads: 0,
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const app = Server.App()

        // Publish the entry
        await app.request("/api/registry/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        })

        // Download it
        const dlRes = await app.request("/api/registry/test-plugin/download/1.0.0")
        expect(dlRes.status).toBe(200)

        // Verify counter was incremented by reading the entry
        const getRes = await app.request("/api/registry/test-plugin")
        expect(getRes.status).toBe(200)
        const body = await getRes.json()
        expect(body.downloads).toBe(1)
      },
    })
  })
})

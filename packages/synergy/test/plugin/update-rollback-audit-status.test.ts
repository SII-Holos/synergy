import { describe, expect, test, mock, beforeEach } from "bun:test"
import * as Audit from "../../src/plugin/audit"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// Mock the plugin loader so getStatus can find a plugin
let mockPlugin: any | null = null
let mockManifest: any | null = null
let pluginId = ""
const mockLoaderState = Object.assign(
  mock(async () => ({ loaded: [] })),
  {
    resetAll: mock(async () => {}),
  },
)

mock.module("../../src/plugin/loader.js", () => ({
  state: mockLoaderState,
  specToPluginId: new Map(),
  resolveSpecPluginDir: mock(() => "/tmp/rollback-test"),
  getPlugin: mock(async (id: string) => {
    if (mockPlugin && mockPlugin.id === id) return mockPlugin
    return null
  }),
  getLoadedPlugins: mock(async () => []),
  incrementReloadVersion: mock(() => {}),
}))

mock.module("../../src/plugin/manifest-reader.js", () => ({
  read: mock(async () => mockManifest),
}))

// Import status AFTER all mocks are in place
const { getStatus } = await import("../../src/plugin/status.js")

beforeEach(() => {
  pluginId = `rollback-test-plugin-${crypto.randomUUID()}`
  mockPlugin = {
    id: pluginId,
    name: "Rollback Test",
    hooks: {},
    pluginDir: "/tmp/rollback-test",
  }
  mockManifest = {
    name: pluginId,
    version: "1.0.0",
    permissions: {},
    contributes: {},
  }
})

async function recordRollback(details: Record<string, unknown>) {
  await Audit.recordEvent({
    pluginId,
    type: "update_failed_rolled_back",
    details,
  })
}

// ---------------------------------------------------------------------------
// Status: update_failed_rolled_back warning
// ---------------------------------------------------------------------------

describe("Status: update_failed_rolled_back warning", () => {
  test("getStatus returns rollback warning when recent update_failed_rolled_back audit event exists", async () => {
    await recordRollback({
      oldVersion: "1.0.0",
      newVersion: "2.0.0",
      error: "npm install failed: EACCES",
      rolledBack: true,
    })

    const status = await getStatus(pluginId)
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(1)
    expect(rollbackWarnings[0].message).toContain("rolled back")
    expect(rollbackWarnings[0].message).toContain("1.0.0")
    expect(rollbackWarnings[0].message).toContain("2.0.0")
  })

  test("getStatus does NOT return rollback warning when no relevant audit event exists", async () => {
    await Audit.recordEvent({
      pluginId,
      type: "install_approved",
      details: {},
    })

    const status = await getStatus(pluginId)
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(0)
  })

  test("rollback warning message includes version info from audit details", async () => {
    await recordRollback({
      oldVersion: "0.9.0",
      newVersion: "3.0.0",
      error: "sigterm during startup",
      rolledBack: true,
    })

    const status = await getStatus(pluginId)
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(1)
    expect(rollbackWarnings[0].message).toContain("0.9.0")
    expect(rollbackWarnings[0].message).toContain("3.0.0")
  })

  test("rollback warning is returned alongside other warnings", async () => {
    await recordRollback({
      oldVersion: "1.0.0",
      newVersion: "2.0.0",
      error: "crash",
      rolledBack: true,
    })

    const status = await getStatus(pluginId)
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(1)
  })

  test("multiple rollback events produce one warning per event", async () => {
    await recordRollback({ oldVersion: "1.0.0", newVersion: "1.1.0", error: "first fail" })
    await recordRollback({ oldVersion: "1.0.0", newVersion: "1.2.0", error: "second fail" })

    const status = await getStatus(pluginId)
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(2)
  })
})

describe("Status: plugin stores", () => {
  test("does not report config store when plugin has no config access", async () => {
    mockManifest = {
      name: pluginId,
      version: "1.0.0",
      permissions: { data: { config: "none" } },
      contributes: {},
    }

    const status = await getStatus(pluginId)
    expect(status?.stores.config).toBe(false)
  })

  test("reports config store when plugin declares plugin config access", async () => {
    mockManifest = {
      name: pluginId,
      version: "1.0.0",
      permissions: { data: { config: "plugin" } },
      contributes: {},
    }

    const status = await getStatus(pluginId)
    expect(status?.stores.config).toBe(true)
  })
})

import { describe, expect, test, mock, beforeEach } from "bun:test"
import type { PluginAuditEvent } from "../../src/plugin/audit"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// Mock the audit module BEFORE importing status.
// The status module now imports getEvents from audit to detect rollback events.
// ---------------------------------------------------------------------------

let mockEvents: PluginAuditEvent[] = []

mock.module("../../src/plugin/audit.js", () => ({
  recordEvent: mock(async () => {}),
  getEvents: mock(async (pluginId?: string) => {
    const filtered = pluginId ? mockEvents.filter((e) => e.pluginId === pluginId) : mockEvents
    return filtered
  }),
  getRecentEvents: mock(async () => mockEvents),
}))

// Mock the plugin loader so getStatus can find a plugin
let mockPlugin: any | null = null
let mockManifest: any | null = null

mock.module("../../src/plugin/loader.js", () => ({
  getPlugin: mock(async (id: string) => {
    if (mockPlugin && mockPlugin.id === id) return mockPlugin
    return null
  }),
  getLoadedPlugins: mock(async () => []),
}))

mock.module("../../src/plugin/manifest-reader.js", () => ({
  read: mock(async () => mockManifest),
}))

// Import status AFTER all mocks are in place
const { getStatus } = await import("../../src/plugin/status.js")

beforeEach(() => {
  mockEvents = []
  mockPlugin = {
    id: "rollback-test-plugin",
    name: "Rollback Test",
    hooks: {},
    pluginDir: "/tmp/rollback-test",
  }
  mockManifest = {
    name: "rollback-test-plugin",
    version: "1.0.0",
    permissions: {},
    contributes: {},
  }
})

// ---------------------------------------------------------------------------
// Status: update_failed_rolled_back warning
// ---------------------------------------------------------------------------

describe("Status: update_failed_rolled_back warning", () => {
  test("getStatus returns rollback warning when recent update_failed_rolled_back audit event exists", async () => {
    // Arrange: a recent rollback event for this plugin
    mockEvents = [
      {
        id: "evt-1",
        pluginId: "rollback-test-plugin",
        time: Date.now() - 60_000,
        type: "update_failed_rolled_back",
        details: {
          oldVersion: "1.0.0",
          newVersion: "2.0.0",
          error: "npm install failed: EACCES",
          rolledBack: true,
        },
      },
    ]

    const status = await getStatus("rollback-test-plugin")
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(1)
    expect(rollbackWarnings[0].message).toContain("rolled back")
    expect(rollbackWarnings[0].message).toContain("1.0.0")
    expect(rollbackWarnings[0].message).toContain("2.0.0")
  })

  test("getStatus does NOT return rollback warning when no relevant audit event exists", async () => {
    mockEvents = [
      {
        id: "evt-2",
        pluginId: "rollback-test-plugin",
        time: Date.now(),
        type: "install_approved",
        details: {},
      },
    ]

    const status = await getStatus("rollback-test-plugin")
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(0)
  })

  test("rollback warning message includes version info from audit details", async () => {
    mockEvents = [
      {
        id: "evt-3",
        pluginId: "rollback-test-plugin",
        time: Date.now() - 120_000,
        type: "update_failed_rolled_back",
        details: {
          oldVersion: "0.9.0",
          newVersion: "3.0.0",
          error: "sigterm during startup",
          rolledBack: true,
        },
      },
    ]

    const status = await getStatus("rollback-test-plugin")
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(1)
    expect(rollbackWarnings[0].message).toContain("0.9.0")
    expect(rollbackWarnings[0].message).toContain("3.0.0")
  })

  test("rollback warning is returned alongside other warnings", async () => {
    mockEvents = [
      {
        id: "evt-4",
        pluginId: "rollback-test-plugin",
        time: Date.now() - 30_000,
        type: "update_failed_rolled_back",
        details: {
          oldVersion: "1.0.0",
          newVersion: "2.0.0",
          error: "crash",
          rolledBack: true,
        },
      },
    ]

    const status = await getStatus("rollback-test-plugin")
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(1)
  })

  test("multiple rollback events produce one warning per event", async () => {
    mockEvents = [
      {
        id: "evt-5a",
        pluginId: "rollback-test-plugin",
        time: Date.now() - 180_000,
        type: "update_failed_rolled_back",
        details: { oldVersion: "1.0.0", newVersion: "1.1.0", error: "first fail" },
      },
      {
        id: "evt-5b",
        pluginId: "rollback-test-plugin",
        time: Date.now() - 60_000,
        type: "update_failed_rolled_back",
        details: { oldVersion: "1.0.0", newVersion: "1.2.0", error: "second fail" },
      },
    ]

    const status = await getStatus("rollback-test-plugin")
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(2)
  })
})

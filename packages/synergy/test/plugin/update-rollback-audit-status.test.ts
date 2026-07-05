import { describe, expect, test, beforeEach } from "bun:test"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import * as Audit from "../../src/plugin/audit"
import type { LoadedPlugin } from "../../src/plugin/loader"
import { getStatusForLoadedPlugin } from "../../src/plugin/status"
import { Log } from "../../src/util/log"

Log.init({ print: false })

let plugin: LoadedPlugin
let manifest: PluginManifest
let pluginId = ""

function baseManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: pluginId,
    version: "1.0.0",
    description: "Rollback status test plugin",
    main: "./runtime/index.js",
    permissions: {},
    contributes: {},
    ...overrides,
  }
}

function getStatus() {
  return getStatusForLoadedPlugin(plugin, manifest)
}

beforeEach(() => {
  pluginId = `rollback-test-plugin-${crypto.randomUUID()}`
  plugin = {
    id: pluginId,
    name: "Rollback Test",
    hooks: {},
    manifest: baseManifest(),
    pluginDir: `/tmp/${pluginId}`,
  }
  manifest = baseManifest()
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

    const status = await getStatus()
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

    const status = await getStatus()
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

    const status = await getStatus()
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

    const status = await getStatus()
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(1)
  })

  test("multiple rollback events produce one warning per event", async () => {
    await recordRollback({ oldVersion: "1.0.0", newVersion: "1.1.0", error: "first fail" })
    await recordRollback({ oldVersion: "1.0.0", newVersion: "1.2.0", error: "second fail" })

    const status = await getStatus()
    expect(status).toBeDefined()

    const rollbackWarnings = status!.warnings.filter((w) => w.type === "update_failed_rolled_back")
    expect(rollbackWarnings.length).toBe(2)
  })
})

describe("Status: plugin stores", () => {
  test("does not report config store when plugin has no config access", async () => {
    manifest = baseManifest({
      permissions: { data: { config: "none", secrets: "none", session: "none", workspace: "none" } },
    })

    const status = await getStatus()
    expect(status?.stores.config).toBe(false)
  })

  test("reports config store when plugin declares plugin config access", async () => {
    manifest = baseManifest({
      permissions: { data: { config: "plugin", secrets: "none", session: "none", workspace: "none" } },
    })

    const status = await getStatus()
    expect(status?.stores.config).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { compilePluginManifest, definePlugin, event } from "@ericsanchezok/synergy-plugin"
import { computeManifestHash, computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import { migratePluginCatalog } from "../../src/plugin/migration"
import { verifyApproval } from "../../src/plugin/consent/approval-store"
import { tmpdir } from "../fixture/fixture"

describe("plugin catalog migration", () => {
  test("keeps valid API 4 grants, drops invalid legacy approvals, and is idempotent", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".synergy")
    const data = path.join(root, "data")
    const cache = path.join(root, "cache")
    const pluginDir = path.join(tmp.path, "valid-plugin")
    await fs.mkdir(pluginDir, { recursive: true })
    const manifest = compilePluginManifest(
      definePlugin({
        id: "migrated-plugin",
        version: "2.0.0",
        description: "Migration fixture",
        contributions: [event({ id: "changed", payload: z.object({}) })],
      }),
      { generation: "migrated-generation" },
    )
    await Bun.write(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest))
    await fs.mkdir(data, { recursive: true })
    await Bun.write(
      path.join(root, "plugin.lock"),
      JSON.stringify({
        version: 1,
        plugins: {
          oldKey: { spec: "file:valid", resolved: pluginDir, integrity: "old-integrity" },
          incompatible: { spec: "file:old", resolved: path.join(tmp.path, "missing") },
        },
      }),
    )
    await Bun.write(
      path.join(data, "plugin-approvals.json"),
      JSON.stringify([
        {
          pluginId: "migrated-plugin",
          source: "local",
          version: manifest.version,
          manifestHash: computeManifestHash(manifest),
          capabilitiesHash: computePermissionsHash(manifest),
          approvedCapabilities: [],
          status: "approved",
          approvedAt: 1,
        },
        {
          pluginId: "tampered-plugin",
          source: "local",
          manifestHash: "wrong",
          capabilitiesHash: "wrong",
          approvedCapabilities: [],
          status: "approved",
          approvedAt: 2,
        },
      ]),
    )
    const settingsPath = path.join(data, "plugin-user-settings.json")
    await Bun.write(settingsPath, JSON.stringify({ "migrated-plugin": { enabled: true } }))
    await fs.mkdir(path.join(cache, "plugin"), { recursive: true })
    await Bun.write(path.join(cache, "plugin", "temporary"), "discard")
    await fs.mkdir(path.join(cache, "plugin-market"), { recursive: true })
    await Bun.write(path.join(cache, "plugin-market", "registry.json"), "{}")

    await migratePluginCatalog({ root, data, cache })

    const lock = JSON.parse(await Bun.file(path.join(root, "plugin.lock")).text())
    expect(lock.version).toBe(2)
    expect(lock.plugins["migrated-plugin"]).toMatchObject({
      version: "2.0.0",
      apiVersion: "4.0",
      generation: "migrated-generation",
    })
    const incompatible = JSON.parse(await Bun.file(path.join(data, "plugin-incompatible.json")).text())
    expect(incompatible).toEqual([{ pluginId: "incompatible", spec: "file:old", reason: "reinstallRequired" }])
    const approvals = JSON.parse(await Bun.file(path.join(data, "plugin-approvals.json")).text())
    expect(approvals[0]).toMatchObject({
      schemaVersion: 2,
      pluginId: "migrated-plugin",
      approvedCapabilities: [],
    })
    expect(approvals).toHaveLength(1)
    expect(verifyApproval(approvals[0], manifest)).toBe(true)
    expect(JSON.parse(await Bun.file(settingsPath).text())).toEqual({ "migrated-plugin": { enabled: true } })
    expect(await Bun.file(path.join(cache, "plugin", "temporary")).exists()).toBe(false)
    expect(await Bun.file(path.join(cache, "plugin-market", "registry.json")).exists()).toBe(false)

    await migratePluginCatalog({ root, data, cache })
    const rerunApprovals = JSON.parse(await Bun.file(path.join(data, "plugin-approvals.json")).text())
    expect(rerunApprovals).toEqual(approvals)
  })
})

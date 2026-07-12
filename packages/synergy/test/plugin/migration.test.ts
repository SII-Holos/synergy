import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { compilePluginManifest, definePlugin, event } from "@ericsanchezok/synergy-plugin"
import { migratePluginCatalog } from "../../src/plugin/migration"
import { verifyApproval } from "../../src/plugin/consent/approval-store"
import { tmpdir } from "../fixture/fixture"

describe("plugin catalog migration", () => {
  test("keeps recognizable packages and settings, rejects old formats and requires fresh approval", async () => {
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
          version: "1.0.0",
          approvedAt: 1,
        },
      ]),
    )
    const settingsPath = path.join(data, "plugin-user-settings.json")
    await Bun.write(settingsPath, JSON.stringify({ "migrated-plugin": { enabled: true } }))
    await fs.mkdir(path.join(cache, "plugin"), { recursive: true })
    await Bun.write(path.join(cache, "plugin", "temporary"), "discard")

    await migratePluginCatalog({ root, data, cache })

    const lock = JSON.parse(await Bun.file(path.join(root, "plugin.lock")).text())
    expect(lock.version).toBe(2)
    expect(lock.plugins["migrated-plugin"]).toMatchObject({
      version: "2.0.0",
      apiVersion: "3.0",
      generation: "migrated-generation",
    })
    const incompatible = JSON.parse(await Bun.file(path.join(data, "plugin-incompatible.json")).text())
    expect(incompatible).toEqual([{ pluginId: "incompatible", spec: "file:old", reason: "reinstallRequired" }])
    const approvals = JSON.parse(await Bun.file(path.join(data, "plugin-approvals.json")).text())
    expect(approvals[0]).toMatchObject({
      pluginId: "migrated-plugin",
      status: "needsApproval",
      approvedCapabilities: [],
    })
    expect(verifyApproval(approvals[0], manifest)).toBe(false)
    expect(JSON.parse(await Bun.file(settingsPath).text())).toEqual({ "migrated-plugin": { enabled: true } })
    expect(await Bun.file(path.join(cache, "plugin", "temporary")).exists()).toBe(false)
  })
})

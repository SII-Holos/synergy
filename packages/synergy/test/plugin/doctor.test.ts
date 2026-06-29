import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import * as Lockfile from "../../src/plugin/lockfile"
import { doctor } from "../../src/plugin/doctor"

describe("plugin doctor", () => {
  test("fixes duplicate config specs, stale lock entries, and orphan archive caches", async () => {
    const fixtureRoot = path.join(Global.Path.state, "doctor-fixtures")
    const oldDir = path.join(fixtureRoot, "demo-plugin-1.0.0")
    const newDir = path.join(fixtureRoot, "demo-plugin-1.1.0")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(newDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, "plugin.json"), JSON.stringify({ name: "demo-plugin", version: "1.0.0" }))
    fs.writeFileSync(path.join(newDir, "plugin.json"), JSON.stringify({ name: "demo-plugin", version: "1.1.0" }))
    const oldSpec = pathToFileURL(oldDir).href
    const newSpec = pathToFileURL(newDir).href
    const orphanDir = path.join(Global.Path.cache, "plugin-archives", "orphan-plugin-0.1.0.synergy-plugin")
    fs.mkdirSync(orphanDir, { recursive: true })

    await Config.domainUpdate(
      "plugins",
      {
        plugin: [oldSpec, newSpec],
        pluginMarketplace: { enabled: false },
      } as any,
      { mode: "replace-domain" },
    )
    await Lockfile.write({
      version: 1,
      plugins: {
        "demo-plugin": {
          spec: newSpec,
          version: "1.1.0",
          resolved: path.join(newDir, "runtime/index.js"),
          runtimeMode: "process",
        },
        "stale-plugin": {
          spec: "file:///tmp/stale-plugin-0.1.0.synergy-plugin.tgz",
          version: "0.1.0",
          resolved: "/tmp/stale/runtime/index.js",
          runtimeMode: "process",
        },
      },
    })

    const result = await doctor({ fix: true })

    expect(result.issues.some((issue) => issue.type === "duplicate_config_spec" && issue.fixed)).toBe(true)
    expect(result.issues.some((issue) => issue.type === "stale_lock_entry" && issue.fixed)).toBe(true)
    expect(result.issues.some((issue) => issue.type === "orphan_archive_cache" && issue.fixed)).toBe(true)
    expect((await Config.domainGet("plugins")).plugin).toEqual([newSpec])
    expect((await Config.domainGet("plugins")).pluginMarketplace?.enabled).toBe(false)
    expect((await Lockfile.read()).plugins["stale-plugin"]).toBeUndefined()
    expect(fs.existsSync(orphanDir)).toBe(false)
  })
})

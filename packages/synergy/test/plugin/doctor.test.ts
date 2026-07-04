import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import * as Lockfile from "../../src/plugin/lockfile"
import { doctor } from "../../src/plugin/doctor"
import { archiveCacheDir } from "../../src/plugin/spec-resolver"

describe("plugin doctor", () => {
  test("fixes duplicate config specs, stale lock entries, and orphan archive caches", async () => {
    const fixtureRoot = path.join(Global.Path.state, "doctor-fixtures")
    const oldDir = path.join(fixtureRoot, "demo-plugin-1.0.0")
    const newDir = path.join(fixtureRoot, "demo-plugin-1.1.0")
    const driftDir = path.join(fixtureRoot, "drift-plugin-1.1.0")
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(newDir, { recursive: true })
    fs.mkdirSync(driftDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, "plugin.json"), JSON.stringify({ name: "demo-plugin", version: "1.0.0" }))
    fs.writeFileSync(path.join(newDir, "plugin.json"), JSON.stringify({ name: "demo-plugin", version: "1.1.0" }))
    fs.writeFileSync(path.join(driftDir, "plugin.json"), JSON.stringify({ name: "drift-plugin", version: "1.1.0" }))
    const oldSpec = pathToFileURL(oldDir).href
    const newSpec = pathToFileURL(newDir).href
    const driftSpec = pathToFileURL(driftDir).href
    const orphanDir = path.join(Global.Path.cache, "plugin-archives", "orphan-plugin-0.1.0.synergy-plugin")
    fs.mkdirSync(orphanDir, { recursive: true })

    await Config.domainUpdate(
      "plugins",
      {
        plugin: [oldSpec, newSpec, driftSpec],
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
        "drift-plugin": {
          spec: "file:///tmp/drift-plugin-1.0.0.synergy-plugin.tgz",
          version: "1.0.0",
          resolved: "/tmp/drift/runtime/index.js",
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
    expect(result.issues.some((issue) => issue.type === "lock_config_drift" && issue.fixed)).toBe(true)
    expect(result.issues.some((issue) => issue.type === "orphan_archive_cache" && issue.fixed)).toBe(true)
    expect((await Config.domainGet("plugins")).plugin).toEqual([newSpec, driftSpec])
    expect((await Config.domainGet("plugins")).pluginMarketplace?.enabled).toBe(false)
    expect((await Lockfile.read()).plugins["stale-plugin"]).toBeUndefined()
    expect((await Lockfile.read()).plugins["drift-plugin"]).toBeUndefined()
    expect(fs.existsSync(orphanDir)).toBe(false)
  })

  test("fixes invalid archive caches, missing lock resolved paths, and stale runtime state", async () => {
    const fixtureRoot = path.join(Global.Path.state, "doctor-fixtures", `archive-${crypto.randomUUID()}`)
    const pluginDir = path.join(fixtureRoot, "recover-plugin")
    fs.mkdirSync(path.join(pluginDir, "runtime"), { recursive: true })
    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "recover-plugin",
        version: "0.1.0",
        main: "./runtime/index.js",
        description: "Recover plugin",
      }),
    )
    fs.writeFileSync(path.join(pluginDir, "runtime", "index.js"), "export default { id: 'recover-plugin' }\n")
    const archivePath = path.join(fixtureRoot, "recover-plugin-0.1.0.synergy-plugin.tgz")
    const pack = Bun.spawnSync(["tar", "-czf", archivePath, "-C", pluginDir, "."])
    expect(pack.exitCode).toBe(0)

    const spec = pathToFileURL(archivePath).href
    const archiveDir = archiveCacheDir(archivePath)
    fs.rmSync(archiveDir, { recursive: true, force: true })
    fs.mkdirSync(archiveDir, { recursive: true })
    const missingResolved = path.join(archiveDir, "runtime", "missing.js")
    const runtimeStatePath = path.join(Global.Path.data, "plugin-runtime-state.json")
    fs.mkdirSync(path.dirname(runtimeStatePath), { recursive: true })
    fs.writeFileSync(
      runtimeStatePath,
      JSON.stringify([
        {
          pluginId: "recover-plugin",
          mode: "process",
          state: "ready",
          restarts: 0,
          pluginDir: archiveDir,
          entryPath: missingResolved,
        },
      ]),
    )

    await Config.domainUpdate(
      "plugins",
      {
        plugin: [spec],
        pluginMarketplace: { enabled: false },
      } as any,
      { mode: "replace-domain" },
    )
    await Lockfile.write({
      version: 1,
      plugins: {
        "recover-plugin": {
          spec,
          version: "0.1.0",
          resolved: missingResolved,
          runtimeMode: "process",
        },
      },
    })

    const result = await doctor({ fix: true })
    const lockfile = await Lockfile.read()
    const runtimeState = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8"))

    expect(result.issues.some((issue) => issue.type === "invalid_archive_cache" && issue.fixed)).toBe(true)
    expect(result.issues.some((issue) => issue.type === "missing_lock_resolved" && issue.fixed)).toBe(true)
    expect(result.issues.some((issue) => issue.type === "invalid_runtime_state" && issue.fixed)).toBe(true)
    expect(fs.existsSync(path.join(archiveDir, "plugin.json"))).toBe(true)
    expect(fs.existsSync(lockfile.plugins["recover-plugin"]!.resolved)).toBe(true)
    expect(runtimeState).toEqual([])
  })
})

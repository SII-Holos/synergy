import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { doctor } from "../../src/plugin/doctor"
import * as Lockfile from "../../src/plugin/lockfile"

test("doctor reports without mutation, then repairs duplicate config, stale locks and invalid runtime state", async () => {
  await using tmp = await tmpdir({})
  const domain = await Config.domainGet("plugins")
  const lock = await Lockfile.read()
  const statePath = path.join(Global.Path.data, "plugin-runtime-state.json")
  const state = await Bun.file(statePath)
    .text()
    .catch(() => undefined)
  const orphan = path.join(Global.Path.cache, "plugin-archives", `doctor-${crypto.randomUUID()}`)
  const a = path.join(tmp.path, "a")
  const b = path.join(tmp.path, "b")
  const specA = pathToFileURL(a).href
  const specB = pathToFileURL(b).href
  const missingSpec = pathToFileURL(path.join(tmp.path, "missing")).href
  const runtime = { pluginId: "kept", pluginDir: a, entryPath: path.join(a, "index.js") }
  try {
    await Bun.write(path.join(a, "plugin.json"), JSON.stringify({ name: "duplicate" }))
    await Bun.write(path.join(b, "plugin.json"), JSON.stringify({ name: "duplicate" }))
    await Bun.write(runtime.entryPath, "export {}")
    await fs.mkdir(orphan, { recursive: true })
    await Config.domainUpdate("plugins", { plugin: [specA, specB, missingSpec] }, { mode: "replace-domain" })
    const entry = {
      spec: specB,
      source: "local" as const,
      version: "1.0.0",
      apiVersion: "4.0",
      generation: "g",
      resolved: b,
      manifestHash: "hash",
    }
    await Lockfile.write({ version: 2, plugins: { duplicate: entry, stale: { ...entry, spec: "file:///unused" } } })
    await Bun.write(statePath, JSON.stringify([runtime, { pluginId: "missing-entry", pluginDir: b }, null]))
    const observed = await doctor()
    expect(observed.changed).toBe(false)
    expect(observed.issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining([
        "duplicate_config_spec",
        "unresolved_config_spec",
        "stale_lock_entry",
        "orphan_archive_cache",
        "invalid_runtime_state",
      ]),
    )
    expect((await Config.domainGet("plugins")).plugin).toEqual([specA, specB, missingSpec])
    expect((await Lockfile.read()).plugins.stale).toBeDefined()
    expect(await fs.stat(orphan)).toBeDefined()
    const repaired = await doctor({ fix: true })
    expect(repaired.changed).toBe(true)
    expect((await Config.domainGet("plugins")).plugin).toEqual([specB, missingSpec])
    expect(Object.keys((await Lockfile.read()).plugins)).toEqual(["duplicate"])
    expect(await Bun.file(statePath).json()).toEqual([runtime])
    expect(await fs.stat(orphan).catch(() => undefined)).toBeUndefined()
    expect((await doctor()).issues.map((issue) => issue.type)).toEqual(["unresolved_config_spec"])
  } finally {
    await Config.domainUpdate("plugins", domain, { mode: "replace-domain" })
    await Lockfile.write(lock)
    if (state === undefined) await fs.rm(statePath, { force: true })
    else await Bun.write(statePath, state)
    await fs.rm(orphan, { recursive: true, force: true })
  }
})

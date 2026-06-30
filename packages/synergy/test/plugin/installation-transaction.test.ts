import { describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import { Config } from "../../src/config/config"

Log.init({ print: false })
import * as Lockfile from "../../src/plugin/lockfile"
import { PluginInstallationTransaction } from "../../src/plugin/installation-transaction"
import type { ResolvedPluginSpec } from "../../src/plugin/spec-resolver"
import type { LoadedPlugin } from "../../src/plugin/loader"
import { getEvents } from "../../src/plugin/audit"

function resolved(spec: string, version: string): ResolvedPluginSpec {
  return {
    spec,
    pkg: "demo-plugin",
    version,
    source: "local",
    pluginDir: `/tmp/${version}`,
    entryPath: `/tmp/${version}/runtime/index.js`,
    manifest: null,
  }
}

function loaded(version: string): LoadedPlugin {
  return {
    id: "demo-plugin",
    name: "Demo Plugin",
    hooks: {},
    pluginDir: `/tmp/${version}`,
    entryPath: `/tmp/${version}/runtime/index.js`,
    source: "local",
    runtimeMode: "process",
  }
}

async function resetPluginState() {
  await Config.domainUpdate(
    "plugins",
    {
      plugin: [],
      pluginMarketplace: { enabled: false },
    } as any,
    { mode: "replace-domain" },
  )
  await Lockfile.write({ version: 1, plugins: {} })
}

describe("PluginInstallationTransaction.upsert", () => {
  test("commits config and lockfile together while preserving plugin domain settings", async () => {
    await resetPluginState()
    await Config.domainUpdate(
      "plugins",
      {
        ...(await Config.domainGet("plugins")),
        plugin: ["file:///tmp/demo-plugin-1.0.0.synergy-plugin.tgz"],
      } as any,
      { mode: "replace-domain" },
    )

    const plugin = await PluginInstallationTransaction.upsert({
      spec: "file:///tmp/demo-plugin-1.1.0.synergy-plugin.tgz",
      pluginId: "demo-plugin",
      resolved: resolved("file:///tmp/demo-plugin-1.1.0.synergy-plugin.tgz", "1.1.0"),
      lockEntry: {
        spec: "file:///tmp/demo-plugin-1.1.0.synergy-plugin.tgz",
        version: "1.1.0",
        resolved: "/tmp/1.1.0/runtime/index.js",
        runtimeMode: "process",
      },
      reload: async () => {},
      getLoaded: async () => [loaded("1.1.0")],
      resolvePluginId: async (spec) => (spec.includes("demo-plugin") ? "demo-plugin" : null),
    })

    expect(plugin.id).toBe("demo-plugin")
    const domain = await Config.domainGet("plugins")
    expect(domain.plugin).toEqual(["file:///tmp/demo-plugin-1.1.0.synergy-plugin.tgz"])
    expect(domain.pluginMarketplace?.enabled).toBe(false)
    const lockfile = await Lockfile.read()
    expect(lockfile.plugins["demo-plugin"]?.version).toBe("1.1.0")
  })

  test("replaces stale specs using lockfile identity when the old path no longer resolves", async () => {
    await resetPluginState()
    await Config.domainUpdate(
      "plugins",
      {
        ...(await Config.domainGet("plugins")),
        plugin: ["file:///tmp/demo-plugin-0.1.0.synergy-plugin.tgz"],
      } as any,
      { mode: "replace-domain" },
    )
    await Lockfile.write({
      version: 1,
      plugins: {
        "demo-plugin": {
          spec: "file:///tmp/demo-plugin-0.1.0.synergy-plugin.tgz",
          version: "0.1.0",
          resolved: "/tmp/missing/runtime/index.js",
          runtimeMode: "process",
        },
      },
    })

    await PluginInstallationTransaction.upsert({
      spec: "file:///tmp/demo-plugin-0.2.0.synergy-plugin.tgz",
      pluginId: "demo-plugin",
      resolved: resolved("file:///tmp/demo-plugin-0.2.0.synergy-plugin.tgz", "0.2.0"),
      lockEntry: {
        spec: "file:///tmp/demo-plugin-0.2.0.synergy-plugin.tgz",
        version: "0.2.0",
        resolved: "/tmp/0.2.0/runtime/index.js",
        runtimeMode: "process",
      },
      reload: async () => {},
      getLoaded: async () => [loaded("0.2.0")],
      resolvePluginId: () => null,
    })

    const domain = await Config.domainGet("plugins")
    expect(domain.plugin).toEqual(["file:///tmp/demo-plugin-0.2.0.synergy-plugin.tgz"])
    const lockfile = await Lockfile.read()
    expect(lockfile.plugins["demo-plugin"]?.version).toBe("0.2.0")
  })

  test("rolls back config and lockfile when reload verification fails", async () => {
    await resetPluginState()
    await Config.domainUpdate(
      "plugins",
      {
        ...(await Config.domainGet("plugins")),
        plugin: ["file:///tmp/demo-plugin-1.0.0.synergy-plugin.tgz"],
      } as any,
      { mode: "replace-domain" },
    )
    await Lockfile.write({
      version: 1,
      plugins: {
        "demo-plugin": {
          spec: "file:///tmp/demo-plugin-1.0.0.synergy-plugin.tgz",
          version: "1.0.0",
          resolved: "/tmp/1.0.0/runtime/index.js",
          runtimeMode: "process",
        },
      },
    })

    await expect(
      PluginInstallationTransaction.upsert({
        spec: "file:///tmp/demo-plugin-1.1.0.synergy-plugin.tgz",
        pluginId: "demo-plugin",
        resolved: resolved("file:///tmp/demo-plugin-1.1.0.synergy-plugin.tgz", "1.1.0"),
        lockEntry: {
          spec: "file:///tmp/demo-plugin-1.1.0.synergy-plugin.tgz",
          version: "1.1.0",
          resolved: "/tmp/1.1.0/runtime/index.js",
          runtimeMode: "process",
        },
        reload: async () => {},
        getLoaded: async () => [],
        resolvePluginId: async (spec) => (spec.includes("demo-plugin") ? "demo-plugin" : null),
      }),
    ).rejects.toThrow("failed to load")

    const domain = await Config.domainGet("plugins")
    expect(domain.plugin).toEqual(["file:///tmp/demo-plugin-1.0.0.synergy-plugin.tgz"])
    const lockfile = await Lockfile.read()
    expect(lockfile.plugins["demo-plugin"]?.version).toBe("1.0.0")
    const rollbackEvents = await getEvents("demo-plugin")
    expect(
      rollbackEvents.some(
        (event) =>
          event.type === "update_failed_rolled_back" &&
          event.details.oldVersion === "1.0.0" &&
          event.details.newVersion === "1.1.0",
      ),
    ).toBe(true)
  })
})

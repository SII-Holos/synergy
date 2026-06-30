import { describe, expect, test } from "bun:test"
import { incrementReloadVersion, selectLoadCandidates, specToPluginId, type ResolvedLoadCandidate } from "../../src/plugin/loader"
import type { PluginLockfile } from "../../src/plugin/lockfile-schema"

function candidate(configPath: string, pluginId: string): ResolvedLoadCandidate {
  return {
    configPath,
    name: pluginId,
    showInstallUI: false,
    pluginId,
    resolved: {
      spec: configPath,
      pkg: pluginId,
      version: "1.0.0",
      source: "local",
      entryPath: `/tmp/${configPath}/runtime/index.js`,
      pluginDir: `/tmp/${configPath}`,
      manifest: {
        name: pluginId,
        version: "1.0.0",
        main: "./runtime/index.js",
        description: "Test plugin",
      },
    },
  }
}

describe("selectLoadCandidates", () => {
  test("keeps the lockfile spec when duplicate config specs point to one plugin id", () => {
    const oldSpec = "file:///tmp/demo-old"
    const newSpec = "file:///tmp/demo-new"
    const lockfile: PluginLockfile = {
      version: 1,
      plugins: {
        "demo-plugin": {
          spec: oldSpec,
          version: "1.0.0",
          resolved: "/tmp/demo-old/runtime/index.js",
          runtimeMode: "process",
        },
      },
    }

    const selected = selectLoadCandidates(
      [candidate(oldSpec, "demo-plugin"), candidate(newSpec, "demo-plugin")],
      lockfile,
    )
    expect(selected.map((entry) => entry.configPath)).toEqual([oldSpec])
  })

  test("keeps the last config spec when no lockfile entry exists", () => {
    const selected = selectLoadCandidates(
      [candidate("file:///tmp/demo-old", "demo-plugin"), candidate("file:///tmp/demo-new", "demo-plugin")],
      { version: 1, plugins: {} },
    )
    expect(selected.map((entry) => entry.configPath)).toEqual(["file:///tmp/demo-new"])
  })
})

describe("loader reload state", () => {
  test("clears spec id cache when plugin reload version changes", () => {
    specToPluginId.set("file:///tmp/demo-old", "demo-plugin")
    incrementReloadVersion()
    expect(specToPluginId.size).toBe(0)
  })
})

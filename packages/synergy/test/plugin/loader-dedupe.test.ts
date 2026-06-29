import { describe, expect, test } from "bun:test"
import { selectLoadCandidates, type ResolvedLoadCandidate } from "../../src/plugin/loader"
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
      manifest: null,
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

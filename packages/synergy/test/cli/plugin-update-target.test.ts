import { describe, expect, test } from "bun:test"
import type { PluginLockfile } from "../../src/plugin/lockfile-schema"
import { resolvePluginUpdateTargets } from "../../src/cli/cmd/plugin-update-target"

const lockfile: PluginLockfile = {
  version: 2,
  plugins: {
    "vibe-lingo": {
      spec: "file:///plugins/vibe-lingo",
      source: "local",
      version: "0.4.3",
      apiVersion: "3.0",
      generation: "old-generation",
      resolved: "/plugins/vibe-lingo/dist/runtime/index.js",
      manifestHash: "old-manifest",
      approvalId: "vibe-lingo",
    },
  },
}

describe("plugin update target selection", () => {
  test("resolves a lockfile target without loading unrelated incompatible plugins", async () => {
    const result = await resolvePluginUpdateTargets({
      specs: ["file:///plugins/legacy-api3", "file:///plugins/vibe-lingo"],
      target: "vibe-lingo",
      lockfile,
      read: async (spec) => {
        if (spec.includes("legacy-api3")) throw new Error("Plugin API 3.0 is not supported")
        return { id: "vibe-lingo", spec }
      },
      matches: (plugin, target) => plugin.id === target,
    })

    expect(result).toEqual([{ id: "vibe-lingo", spec: "file:///plugins/vibe-lingo" }])
  })

  test("skips unreadable specs while falling back to manifest identity", async () => {
    const result = await resolvePluginUpdateTargets({
      specs: ["file:///plugins/legacy-api3", "file:///plugins/renamed-package"],
      target: "vibe-lingo",
      lockfile: { version: 2, plugins: {} },
      read: async (spec) => {
        if (spec.includes("legacy-api3")) throw new Error("Plugin API 3.0 is not supported")
        return { id: "vibe-lingo", spec }
      },
      matches: (plugin, target) => plugin.id === target,
    })

    expect(result).toEqual([{ id: "vibe-lingo", spec: "file:///plugins/renamed-package" }])
  })
})

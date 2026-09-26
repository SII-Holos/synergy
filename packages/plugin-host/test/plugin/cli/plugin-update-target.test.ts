import { describe, expect, test } from "bun:test"
import type { PluginLockfile } from "@ericsanchezok/synergy-plugin-host/plugin/lockfile-schema"
import { resolvePluginUpdateTargets } from "@ericsanchezok/synergy-plugin-host/plugin/cli/plugin-update-target"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../../support/runtime"
const runtime = await testRuntime()

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
  test("resolves a lockfile target without loading unrelated incompatible plugins", () =>
    runtime.run(async () => {
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
    }))

  test("skips unreadable specs while falling back to manifest identity", () =>
    runtime.run(async () => {
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
    }))
})

afterRuntimeTests(() => runtime.close())

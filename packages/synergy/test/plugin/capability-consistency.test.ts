import { describe, expect, test } from "bun:test"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { baseCapabilities as runtimeBaseCapabilities } from "../../src/plugin/capability"
import { computeRisk as runtimeComputeRisk } from "../../src/plugin/consent/risk"
import {
  computePermissionsHash as runtimeComputePermissionsHash,
  computeManifestHash as runtimeComputeManifestHash,
} from "../../src/plugin/consent/approval-store"
import { baseCapabilities as kitBaseCapabilities } from "../../../plugin-kit/src/lib/capability"
import { computeRisk as kitComputeRisk } from "../../../plugin-kit/src/lib/risk"
import {
  computePermissionsHash as kitComputePermissionsHash,
  computeManifestHash as kitComputeManifestHash,
} from "../../../plugin-kit/src/lib/hash"

describe("plugin capability consistency", () => {
  test("runtime and plugin-kit agree on delegated task permissions", () => {
    const manifest = PluginManifest.parse({
      name: "task-plugin",
      version: "1.0.0",
      description: "Plugin with delegated task permission",
      permissions: {
        tools: {
          invoke: true,
          filesystem: "read",
          network: false,
          shell: false,
          mcp: "none",
          task: {
            agents: ["planner"],
            maxRuntimeMs: 30_000,
          },
        },
        data: {
          session: "none",
          workspace: "none",
          config: "plugin",
          secrets: "none",
        },
      },
    })

    const runtimeCapabilities = runtimeBaseCapabilities(manifest)
    const kitCapabilities = kitBaseCapabilities(manifest)

    expect(runtimeCapabilities).toContain("task")
    expect(kitCapabilities).toEqual(runtimeCapabilities)
    expect(kitComputeRisk(kitCapabilities, manifest)).toBe(runtimeComputeRisk(runtimeCapabilities, manifest))
    expect(kitComputeManifestHash(manifest)).toBe(runtimeComputeManifestHash(manifest))
    expect(kitComputePermissionsHash(manifest, kitCapabilities)).toBe(
      runtimeComputePermissionsHash(manifest, runtimeCapabilities),
    )
  })
})

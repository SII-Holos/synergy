import { describe, expect, test } from "bun:test"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { baseCapabilities, computeRisk } from "@ericsanchezok/synergy-plugin/permissions"
import {
  computePermissionsHash as runtimeComputePermissionsHash,
  computeManifestHash as runtimeComputeManifestHash,
} from "../../src/plugin/consent/approval-store"
import {
  computePermissionsHash as kitComputePermissionsHash,
  computeManifestHash as kitComputeManifestHash,
} from "../../../plugin-kit/src/lib/hash"

describe("plugin capability consistency", () => {
  test("does not grant plugin config access unless manifest declares it", () => {
    const manifest = PluginManifest.parse({
      name: "minimal-plugin",
      version: "1.0.0",
      description: "Plugin without config access",
      permissions: {},
    })

    expect(baseCapabilities(manifest)).not.toContain("config:read")
  })

  test("grants plugin config access when manifest declares it", () => {
    const manifest = PluginManifest.parse({
      name: "config-plugin",
      version: "1.0.0",
      description: "Plugin with config access",
      permissions: {
        data: {
          config: "plugin",
        },
      },
    })

    expect(baseCapabilities(manifest)).toContain("config:read")
  })

  test("runtime and plugin-kit agree on delegated task permissions", () => {
    const manifest = PluginManifest.parse({
      name: "task-plugin",
      version: "1.0.0",
      description: "Plugin with delegated task permission",
      permissions: {
        tools: {
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

    const runtimeCapabilities = baseCapabilities(manifest)
    const kitCapabilities = baseCapabilities(manifest)

    expect(runtimeCapabilities).toContain("task")
    expect(kitCapabilities).toEqual(runtimeCapabilities)
    expect(computeRisk(kitCapabilities, manifest)).toBe(computeRisk(runtimeCapabilities, manifest))
    expect(kitComputeManifestHash(manifest)).toBe(runtimeComputeManifestHash(manifest))
    expect(kitComputePermissionsHash(manifest, kitCapabilities)).toBe(
      runtimeComputePermissionsHash(manifest, runtimeCapabilities),
    )
  })
})

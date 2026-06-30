import { describe, expect, test } from "bun:test"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import {
  baseCapabilities,
  capabilityRisk,
  computeRisk,
  permissionCapability,
  PROFILE_CAPABILITIES,
} from "@ericsanchezok/synergy-plugin/permissions"
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

  test("does not grant a plugin-specific invoke capability", () => {
    const manifest = PluginManifest.parse({
      name: "minimal-plugin",
      version: "1.0.0",
      description: "Plugin without host-service capabilities",
      permissions: {},
    })

    expect(baseCapabilities(manifest)).not.toContain("tool_invoke")
    expect(PROFILE_CAPABILITIES).not.toContain("tool_invoke")
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

  test("Synergy permission names map to shared capability classes", () => {
    const mappings: Record<string, string> = {
      download: "network_read",
      scan_document: "file_read",
      look_at: "file_read",
      ast_grep: "file_read",
      lsp: "file_read",
      dagread: "file_read",
      todoread: "file_read",
      question: "file_read",
      skill: "file_read",
      dagwrite: "session_state",
      dagpatch: "session_state",
      todowrite: "session_state",
      doom_loop: "session_state",
      worktree_enter: "file_write",
      worktree_leave: "file_write",
    }

    for (const [permission, capability] of Object.entries(mappings)) {
      expect(permissionCapability(permission)).toBe(capability)
    }
  })

  test("unknown capabilities fail closed as high risk", () => {
    expect(capabilityRisk("unknown_future_capability")).toBe("high")
  })
})

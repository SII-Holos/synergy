import { describe, expect, test } from "bun:test"
import { diffPermissions } from "../../src/plugin/consent/diff"
import { computeRisk } from "../../src/plugin/consent/risk"
import { generatePermissionItems } from "../../src/plugin/consent/summary"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  const base: PluginManifest = {
    name: "test-plugin",
    version: "1.0.0",
    description: "A test plugin",
  } as PluginManifest
  return { ...base, ...overrides } as PluginManifest
}

describe("consent module", () => {
  describe("computeRisk", () => {
    test("no capabilities returns low", () => {
      expect(computeRisk([])).toBe("low")
    })

    test("shell is high", () => {
      expect(computeRisk(["shell"])).toBe("high")
    })

    test("filesystem:write is high", () => {
      expect(computeRisk(["filesystem:write"])).toBe("high")
    })

    test("filesystem:read is medium", () => {
      expect(computeRisk(["filesystem:read"])).toBe("medium")
    })

    test("network is high (undeclared domains)", () => {
      expect(computeRisk(["network"])).toBe("high")
    })

    test("config:read is low", () => {
      expect(computeRisk(["config:read"])).toBe("low")
    })

    test("task delegation is medium", () => {
      expect(computeRisk(["task"])).toBe("medium")
    })

    test("plugin_invoke is low", () => {
      expect(computeRisk(["plugin_invoke"])).toBe("low")
    })

    test("high + medium = high", () => {
      expect(computeRisk(["filesystem:read", "shell"])).toBe("high")
    })
  })

  describe("diffPermissions", () => {
    test("new plugin → all in added, requiresApproval=true", () => {
      const manifest = makeManifest()
      const diff = diffPermissions("test-plugin", null, manifest, [], ["shell", "plugin_invoke"])
      expect(diff.added.length).toBeGreaterThan(0)
      expect(diff.removed.length).toBe(0)
      expect(diff.unchanged.length).toBe(0)
      expect(diff.changed.length).toBe(0)
      expect(diff.requiresApproval).toBe(true)
      expect(diff.fromVersion).toBeUndefined()
      expect(diff.riskAfter).toBe("high")
    })

    test("same capabilities → requiresApproval=false", () => {
      const manifest = makeManifest()
      const caps = ["plugin_invoke", "filesystem:read"]
      const diff = diffPermissions("test-plugin", manifest, manifest, caps, caps)
      expect(diff.requiresApproval).toBe(false)
      expect(diff.added.length).toBe(0)
      expect(diff.removed.length).toBe(0)
      expect(diff.unchanged.length).toBe(caps.length)
      expect(diff.changed.length).toBe(0)
    })

    test("capability added → requiresApproval=true", () => {
      const manifest = makeManifest()
      const diff = diffPermissions(
        "test-plugin",
        manifest,
        manifest,
        ["plugin_invoke"],
        ["plugin_invoke", "filesystem:read"],
      )
      expect(diff.requiresApproval).toBe(true)
      expect(diff.added.length).toBe(1)
      expect(diff.unchanged.length).toBe(1)
    })

    test("risk change → requiresApproval=true", () => {
      const manifest = makeManifest()
      const diff = diffPermissions("test-plugin", manifest, manifest, ["plugin_invoke"], ["plugin_invoke", "shell"])
      expect(diff.requiresApproval).toBe(true)
      expect(diff.riskBefore).toBe("low")
      expect(diff.riskAfter).toBe("high")
    })
  })

  describe("generatePermissionItems", () => {
    test("maps shell capability to runtime item", () => {
      const manifest = makeManifest()
      const items = generatePermissionItems(manifest, ["shell"])
      expect(items.length).toBe(1)
      expect(items[0].key).toBe("shell")
      expect(items[0].category).toBe("runtime")
      expect(items[0].severity).toBe("high")
    })

    test("maps filesystem:read to files item", () => {
      const manifest = makeManifest()
      const items = generatePermissionItems(manifest, ["filesystem:read"])
      expect(items[0].category).toBe("files")
      expect(items[0].severity).toBe("medium")
    })

    test("network with declared domains is medium", () => {
      const manifest = makeManifest({
        permissions: {
          network: {
            connectDomains: ["api.example.com"],
            resourceDomains: [],
            frameDomains: [],
          },
        },
      })
      const items = generatePermissionItems(manifest, ["network"])
      expect(items[0].severity).toBe("medium")
      expect(items[0].description).toContain("api.example.com")
    })

    test("network without domains is high", () => {
      const manifest = makeManifest()
      const items = generatePermissionItems(manifest, ["network"])
      expect(items[0].severity).toBe("high")
    })

    test("task delegation is medium", () => {
      const manifest = makeManifest()
      const items = generatePermissionItems(manifest, ["task"])
      expect(items[0].key).toBe("task")
      expect(items[0].severity).toBe("medium")
    })
  })
})

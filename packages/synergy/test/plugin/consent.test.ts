import { describe, expect, test } from "bun:test"
import { diffPermissions } from "../../src/plugin/consent/diff"
import { computeRisk } from "@ericsanchezok/synergy-plugin/permissions"
import { generatePermissionItems } from "../../src/plugin/consent/summary"
import { PluginManifest as PluginManifestSchema, type PluginManifest } from "@ericsanchezok/synergy-plugin"

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

    test("shell is medium", () => {
      expect(computeRisk(["shell"])).toBe("medium")
    })

    test("file_write is medium", () => {
      expect(computeRisk(["file_write"])).toBe("medium")
    })

    test("file_read is low", () => {
      expect(computeRisk(["file_read"])).toBe("low")
    })

    test("network_request uses catalog risk without manifest context", () => {
      expect(computeRisk(["network_request"])).toBe("medium")
    })

    test("network_request is high when a manifest allows any domain", () => {
      expect(
        computeRisk(
          ["network_request"],
          makeManifest({
            permissions: {
              network: {
                connectDomains: [],
                resourceDomains: [],
                frameDomains: [],
              },
            },
          }),
        ),
      ).toBe("high")
    })

    test("network_request is medium when domains are constrained", () => {
      expect(
        computeRisk(
          ["network_request"],
          makeManifest({
            permissions: {
              network: {
                connectDomains: ["api.example.com"],
                resourceDomains: [],
                frameDomains: [],
              },
            },
          }),
        ),
      ).toBe("medium")
    })

    test("config:read is low", () => {
      expect(computeRisk(["config:read"])).toBe("low")
    })

    test("task delegation is low", () => {
      expect(computeRisk(["task"])).toBe("low")
    })

    test("high + medium = high", () => {
      expect(computeRisk(["file_read", "secrets"])).toBe("high")
    })
  })

  describe("diffPermissions", () => {
    test("new plugin → all in added, requiresApproval=true", () => {
      const manifest = makeManifest()
      const diff = diffPermissions("test-plugin", null, manifest, [], ["shell"])
      expect(diff.added.length).toBeGreaterThan(0)
      expect(diff.removed.length).toBe(0)
      expect(diff.unchanged.length).toBe(0)
      expect(diff.changed.length).toBe(0)
      expect(diff.requiresApproval).toBe(true)
      expect(diff.fromVersion).toBeUndefined()
      expect(diff.riskAfter).toBe("medium")
    })

    test("same capabilities → requiresApproval=false", () => {
      const manifest = makeManifest()
      const caps = ["file_read"]
      const diff = diffPermissions("test-plugin", manifest, manifest, caps, caps)
      expect(diff.requiresApproval).toBe(false)
      expect(diff.added.length).toBe(0)
      expect(diff.removed.length).toBe(0)
      expect(diff.unchanged.length).toBe(caps.length)
      expect(diff.changed.length).toBe(0)
    })

    test("capability added → requiresApproval=true", () => {
      const manifest = makeManifest()
      const diff = diffPermissions("test-plugin", manifest, manifest, [], ["file_read"])
      expect(diff.requiresApproval).toBe(true)
      expect(diff.added.length).toBe(1)
      expect(diff.unchanged.length).toBe(0)
    })

    test("risk change → requiresApproval=true", () => {
      const manifest = makeManifest()
      const diff = diffPermissions("test-plugin", manifest, manifest, [], ["shell"])
      expect(diff.requiresApproval).toBe(true)
      expect(diff.riskBefore).toBe("low")
      expect(diff.riskAfter).toBe("medium")
    })
  })

  describe("generatePermissionItems", () => {
    test("maps shell capability to runtime item", () => {
      const manifest = makeManifest()
      const items = generatePermissionItems(manifest, ["shell"])
      expect(items.length).toBe(1)
      expect(items[0].key).toBe("shell")
      expect(items[0].category).toBe("runtime")
      expect(items[0].severity).toBe("medium")
    })

    test("maps file_read to files item", () => {
      const manifest = makeManifest()
      const items = generatePermissionItems(manifest, ["file_read"])
      expect(items[0].category).toBe("files")
      expect(items[0].severity).toBe("low")
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
      const items = generatePermissionItems(manifest, ["network_request"])
      expect(items[0].severity).toBe("medium")
      expect(items[0].description).toContain("api.example.com")
    })

    test("network without domains is high", () => {
      const manifest = makeManifest()
      const items = generatePermissionItems(manifest, ["network_request"])
      expect(items[0].severity).toBe("high")
    })

    test("task delegation is low", () => {
      const manifest = makeManifest()
      const items = generatePermissionItems(manifest, ["task"])
      expect(items[0].key).toBe("task")
      expect(items[0].severity).toBe("low")
    })

    test("config hook is a medium hook permission item", () => {
      const manifest = PluginManifestSchema.parse({
        name: "test-plugin",
        version: "1.0.0",
        description: "A test plugin",
        permissions: {
          hooks: {
            config: true,
          },
        },
      })
      const items = generatePermissionItems(manifest, ["config_hook"])
      expect(items.some((item) => item.key === "config_hook" && item.category === "hooks")).toBe(true)
      expect(items.some((item) => item.key === "hooks.config" && item.severity === "medium")).toBe(true)
    })
  })
})

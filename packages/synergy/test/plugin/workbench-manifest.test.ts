import { describe, expect, test } from "bun:test"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"

function expectUnknownKey(parsed: ReturnType<typeof PluginManifest.safeParse>, path: string, key: string) {
  expect(parsed.success).toBe(false)
  if (parsed.success) return
  expect(
    parsed.error.issues.some((issue) => {
      const keys = "keys" in issue ? issue.keys : undefined
      return issue.path.join(".") === path && Array.isArray(keys) && keys.includes(key)
    }),
  ).toBe(true)
}

describe("workbench panel manifest contributions", () => {
  test("accepts workbenchPanels with surface and cardinality metadata", () => {
    const manifest = PluginManifest.parse({
      name: "workbench-plugin",
      version: "1.0.0",
      description: "Workbench panel plugin",
      contributes: {
        ui: {
          entry: "./dist/ui/index.js",
          minUIApiVersion: "1.0",
          workbenchPanels: [
            {
              id: "notes-adjacent",
              label: "Notebook",
              icon: "notebook-pen",
              surface: "side",
              cardinality: "singleton",
            },
            {
              id: "build-log",
              label: "Build Log",
              icon: "terminal",
              surface: "bottom",
              cardinality: "multi",
              requiresSession: true,
            },
          ],
        },
      },
      permissions: {
        ui: true,
      },
    })

    expect(manifest.contributes?.ui?.workbenchPanels?.[0]?.requiresSession).toBeUndefined()
    expect(manifest.contributes?.ui?.workbenchPanels?.[1]?.requiresSession).toBe(true)
    expect(manifest.permissions?.ui).toBe(true)
  })

  test("accepts navigation, message slots, composer slots, and UI commands", () => {
    const manifest = PluginManifest.parse({
      name: "web-surface-plugin",
      version: "1.0.0",
      description: "Web UI surface plugin",
      contributes: {
        ui: {
          entry: "./dist/ui/index.js",
          minUIApiVersion: "1.0",
          navigation: [
            {
              id: "dashboard",
              label: "Dashboard",
              icon: "layout-dashboard",
              placement: "sidebar" as const,
              exportName: "DashboardPanel",
              order: 25,
            },
          ],
          messageSlots: [{ id: "after-tools", slot: "after-tools", exportName: "AfterToolsSlot" }],
          composerSlots: [{ id: "toolbar-left", slot: "composer.toolbar.left" as const, exportName: "ToolbarLeft" }],
          commands: [{ id: "open", label: "Open", exportName: "openCommand" }],
        },
      },
      permissions: {
        ui: true,
      },
    })

    expect(manifest.contributes?.ui?.navigation?.[0]?.order).toBe(25)
    expect(manifest.contributes?.ui?.messageSlots?.[0]?.slot).toBe("after-tools")
    expect(manifest.contributes?.ui?.composerSlots?.[0]?.id).toBe("toolbar-left")
    expect(manifest.permissions?.ui).toBe(true)
  })

  test("rejects removed workspacePanels contributions as an unknown UI field", () => {
    const parsed = PluginManifest.safeParse({
      name: "legacy-plugin",
      version: "1.0.0",
      description: "Manifest using removed panel field",
      contributes: {
        ui: {
          workspacePanels: [
            {
              id: "legacy",
              label: "Legacy",
              icon: "panel-right",
            },
          ],
        },
      },
    })

    expectUnknownKey(parsed, "contributes.ui", "workspacePanels")
  })

  test("rejects removed UI contribution keys", () => {
    const removedFields: Array<[string, unknown]> = [
      ["globalPanels", [{ id: "global", label: "Global", icon: "globe" }]],
      ["chatComponents", [{ id: "chat", slot: "after-tools", exportName: "ChatComponent" }]],
      ["routes", [{ path: "/plugins/legacy", entry: "default", label: "Legacy" }]],
    ]

    for (const [field, value] of removedFields) {
      const parsed = PluginManifest.safeParse({
        name: "legacy-plugin",
        version: "1.0.0",
        description: "Manifest using removed UI field",
        contributes: {
          ui: {
            [field]: value,
          },
        },
      })

      expectUnknownKey(parsed, "contributes.ui", field)
    }
  })

  test("rejects removed UI permission keys", () => {
    for (const field of ["globalPanels", "chatComponents", "routes"]) {
      const parsed = PluginManifest.safeParse({
        name: "legacy-plugin",
        version: "1.0.0",
        description: "Manifest using removed UI permission",
        permissions: {
          ui: { [field]: true } as any,
        },
      })

      expect(parsed.success).toBe(false)
    }
  })
})

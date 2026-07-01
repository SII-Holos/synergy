import { describe, expect, test } from "bun:test"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"

describe("workbench panel manifest contributions", () => {
  test("accepts workbenchPanels with surface and cardinality metadata", () => {
    const manifest = PluginManifest.parse({
      name: "workbench-plugin",
      version: "1.0.0",
      description: "Workbench panel plugin",
      contributes: {
        ui: {
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
        ui: {
          workbenchPanels: true,
        },
      },
    })

    expect(manifest.contributes?.ui?.workbenchPanels?.[0]?.requiresSession).toBeUndefined()
    expect(manifest.contributes?.ui?.workbenchPanels?.[1]?.requiresSession).toBe(true)
    expect(manifest.permissions?.ui?.workbenchPanels).toBe(true)
  })

  test("rejects removed workspacePanels contributions with a clear migration message", () => {
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

    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.map((issue) => issue.message).join("\n")).toContain("use contributes.ui.workbenchPanels")
  })
})

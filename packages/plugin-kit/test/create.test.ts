import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { buildPluginProject } from "../src/commands/build"
import { scaffoldPluginProject } from "../src/commands/create"

describe("plugin project scaffolds", () => {
  test("theme-icon emits a structured theme that survives build", async () => {
    const parent = fs.mkdtempSync(path.join(import.meta.dir, "create-fixture-"))
    const root = path.join(parent, "ocean-theme")
    try {
      scaffoldPluginProject("ocean-theme", "theme-icon", root)
      const themePath = path.join(root, "themes", "default.json")
      const theme = JSON.parse(fs.readFileSync(themePath, "utf-8"))
      expect(theme.id).toBe("default")
      expect(Object.keys(theme.light.seeds)).toHaveLength(9)
      expect(Object.keys(theme.dark.seeds)).toHaveLength(9)

      expect(await buildPluginProject(root)).toBe(true)
      const manifest = PluginManifest.parse(
        JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf-8")),
      )
      expect(manifest.contributions).toContainEqual({
        kind: "ui.theme",
        id: "default",
        label: "ocean-theme",
        path: "themes/default.json",
      })
      expect(fs.existsSync(path.join(root, "dist", "themes", "default.json"))).toBe(true)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { Theme } from "@ericsanchezok/synergy-plugin/theme"
import { buildPluginProject } from "../src/commands/build"
import { scaffoldPluginProject } from "../src/commands/create"
import { validatePluginProject } from "../src/commands/validate"

describe("plugin project scaffolds", () => {
  test("theme-icon emits a structured theme that survives build", async () => {
    const parent = fs.mkdtempSync(path.join(import.meta.dir, "create-fixture-"))
    const root = path.join(parent, "ocean-theme")
    try {
      scaffoldPluginProject("ocean-theme", "theme-icon", root)
      const themePath = path.join(root, "themes", "default.json")
      const theme = JSON.parse(fs.readFileSync(themePath, "utf-8"))
      expect(theme.id).toBe("default")
      expect(theme.$schema).toBe("./theme.schema.json")
      expect(fs.existsSync(path.join(root, "themes", "theme.schema.json"))).toBe(true)
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
      expect((await validatePluginProject(root)).filter((result) => result.type === "error")).toEqual([])
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test("rejects resolver-invalid themes in build and validation", async () => {
    const parent = fs.mkdtempSync(path.join(import.meta.dir, "invalid-theme-fixture-"))
    const root = path.join(parent, "invalid-theme")
    try {
      scaffoldPluginProject("invalid-theme", "theme-icon", root)
      const themePath = path.join(root, "themes", "default.json")
      const theme = JSON.parse(fs.readFileSync(themePath, "utf-8"))
      theme.dark.overrides = { "border-base": "var(--border-base)" }
      fs.writeFileSync(themePath, `${JSON.stringify(theme, null, 2)}\n`)

      expect(await buildPluginProject(root)).toBe(false)
      const results = await validatePluginProject(root)
      expect(results.some((result) => result.type === "error" && result.message.includes("Cyclic theme token"))).toBe(
        true,
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test("theme asset content changes the plugin generation", async () => {
    const parent = fs.mkdtempSync(path.join(import.meta.dir, "theme-generation-fixture-"))
    const root = path.join(parent, "theme-generation")
    try {
      scaffoldPluginProject("theme-generation", "theme-icon", root)
      expect(await buildPluginProject(root)).toBe(true)
      const first = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf-8")))
        .artifacts.generation

      const themePath = path.join(root, "themes", "default.json")
      const theme = JSON.parse(fs.readFileSync(themePath, "utf-8"))
      theme.light.seeds.primary = "#1D4ED8"
      fs.writeFileSync(themePath, `${JSON.stringify(theme, null, 2)}\n`)
      expect(await buildPluginProject(root)).toBe(true)
      const second = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf-8")))
        .artifacts.generation

      expect(second).not.toBe(first)
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test("build and validate reject every invalid Theme JSON boundary", async () => {
    const cases: Array<{ name: string; mutate: (root: string, theme: Theme) => void }> = [
      {
        name: "missing",
        mutate: (root) => fs.rmSync(path.join(root, "themes", "default.json")),
      },
      {
        name: "bad-json",
        mutate: (root) => fs.writeFileSync(path.join(root, "themes", "default.json"), "{"),
      },
      {
        name: "unknown-token",
        mutate: (_root, theme) => {
          theme.light.overrides = { "unknown-token": "#ffffff" } as Theme["light"]["overrides"]
        },
      },
      {
        name: "low-contrast",
        mutate: (_root, theme) => {
          theme.light.overrides = { "text-base": "#ffffff" }
        },
      },
      {
        name: "id-mismatch",
        mutate: (_root, theme) => {
          theme.id = "different"
        },
      },
    ]

    for (const fixture of cases) {
      const parent = fs.mkdtempSync(path.join(import.meta.dir, `invalid-${fixture.name}-`))
      const root = path.join(parent, fixture.name)
      try {
        scaffoldPluginProject(fixture.name, "theme-icon", root)
        const themePath = path.join(root, "themes", "default.json")
        const theme = JSON.parse(fs.readFileSync(themePath, "utf8")) as Theme
        fixture.mutate(root, theme)
        if (fs.existsSync(themePath) && fixture.name !== "bad-json") {
          fs.writeFileSync(themePath, `${JSON.stringify(theme, null, 2)}\n`)
        }
        expect(await buildPluginProject(root)).toBe(false)
        expect((await validatePluginProject(root)).some((result) => result.type === "error")).toBe(true)
      } finally {
        fs.rmSync(parent, { recursive: true, force: true })
      }
    }
  })
})

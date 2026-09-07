import { expect, test } from "bun:test"
import path from "node:path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { buildPluginProject } from "../src/commands/build"
import { validatePluginProject } from "../src/commands/validate"
import { createFixtureProject, writeMinimalPlugin } from "./fixtures"

test("Skin builds include their declared resource graph and preserve last valid output on missing resources", async () => {
  const project = createFixtureProject("skin-assets")
  try {
    writeMinimalPlugin(
      project,
      `import { definePlugin, skin } from "@ericsanchezok/synergy-plugin"
export default definePlugin({ id: "skin-assets", version: "1.0.0", description: "Skin fixture", contributions: [skin({ id: "paper", label: "Paper", path: "skins/paper.json" })] })`,
      "skin-assets",
    )
    const skin = {
      version: 1,
      id: "paper",
      assets: { texture: { kind: "image", path: "assets/paper.svg" } },
      light: { parts: { workbench: { background: { asset: "texture" } } } },
      dark: { parts: {} },
      narrow: { parts: {} },
      reducedMotion: { decorations: "hide" },
    }
    project.writeFile("skins/paper.json", JSON.stringify(skin))
    project.writeFile("assets/paper.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
    expect(await buildPluginProject(project.root)).toBe(true)
    const manifest = PluginManifest.parse(await Bun.file(path.join(project.root, "dist/plugin.json")).json())
    expect(manifest.contributions[0]?.kind).toBe("ui.skin")
    expect(await Bun.file(path.join(project.root, "dist/assets/paper.svg")).exists()).toBe(true)
    expect((await validatePluginProject(project.root)).filter((result) => result.type === "error")).toEqual([])
    project.writeFile(
      "skins/paper.json",
      JSON.stringify({ ...skin, assets: { texture: { kind: "image", path: "missing.svg" } } }),
    )
    expect(await buildPluginProject(project.root)).toBe(false)
    expect(await Bun.file(path.join(project.root, "dist/plugin.json")).json()).toEqual(manifest)
  } finally {
    project.cleanup()
  }
})

import { expect, test } from "bun:test"
import path from "node:path"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { buildPluginProject } from "../src/commands/build"
import { validatePluginProject } from "../src/commands/validate"
import { sha256File } from "../src/lib/crypto"
import { createFixtureProject, writeMinimalPlugin } from "./fixtures"

test("UI artifacts declare their author API and every emitted stylesheet", async () => {
  const project = createFixtureProject("ui-artifact")
  try {
    writeMinimalPlugin(
      project,
      `
import { definePlugin, workbenchPanel } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "ui-artifact",
  version: "1.0.0",
  description: "UI artifact contract",
  contributions: [workbenchPanel({
    id: "panel", label: "Panel", surface: "side", cardinality: "singleton",
    component: { source: "./src/panel.tsx" },
  })],
})
`,
      "ui-artifact",
    )
    project.writeFile(
      "src/panel.tsx",
      `
import "./panel.css"
export default function Panel(props) {
  return <section class="panel">{props.context.surface.id}</section>
}
`,
    )
    project.writeFile("src/panel.css", ".panel { display: grid; }")
    expect(await buildPluginProject(project.root)).toBe(true)
    const manifest = PluginManifest.parse(await Bun.file(path.join(project.root, "dist/plugin.json")).json())
    expect(manifest.apiVersion).toBe("4.0")
    expect(manifest.artifacts.ui).toMatchObject({
      apiVersion: "5.0",
      entry: "ui/index.js",
      resources: [
        {
          entry: "ui/index.css",
          kind: "stylesheet",
          sha256: sha256File(path.join(project.root, "dist/ui/index.css")),
        },
      ],
    })
    await Bun.write(path.join(project.root, "dist/ui/index.css"), ".tampered { display: none; }")
    const validation = await validatePluginProject(project.root)
    expect(validation.some((result) => result.type === "error" && result.message.includes("ui/index.css"))).toBe(true)
  } finally {
    project.cleanup()
  }
})

test("an invalid rebuild preserves the last complete installable artifact", async () => {
  const project = createFixtureProject("last-valid-ui")
  try {
    writeMinimalPlugin(
      project,
      `import { definePlugin, workbenchPanel } from "@ericsanchezok/synergy-plugin"
export default definePlugin({ id: "last-valid-ui", version: "1.0.0", description: "Last valid build", contributions: [workbenchPanel({ id: "panel", label: "Panel", surface: "side", cardinality: "singleton", component: { source: "./src/panel.tsx" } })] })`,
      "last-valid-ui",
    )
    project.writeFile("src/panel.tsx", "export default () => <div>Valid generation</div>")
    expect(await buildPluginProject(project.root)).toBe(true)
    const manifest = await Bun.file(path.join(project.root, "dist/plugin.json")).text()
    const bundle = await Bun.file(path.join(project.root, "dist/ui/index.js")).text()
    project.writeFile("src/panel.tsx", "export default () => <div>Invalid")
    expect(await buildPluginProject(project.root)).toBe(false)
    expect(await Bun.file(path.join(project.root, "dist/plugin.json")).text()).toBe(manifest)
    expect(await Bun.file(path.join(project.root, "dist/ui/index.js")).text()).toBe(bundle)
  } finally {
    project.cleanup()
  }
})

test("imported UI images resolve from the executable module and appear in the hashed resource list", async () => {
  const project = createFixtureProject("ui-image")
  try {
    writeMinimalPlugin(
      project,
      `import { definePlugin, workbenchPanel } from "@ericsanchezok/synergy-plugin"
export default definePlugin({ id: "ui-image", version: "1.0.0", description: "Image", contributions: [workbenchPanel({ id: "panel", label: "Panel", surface: "side", cardinality: "singleton", component: { source: "./src/panel.ts" } })] })`,
      "ui-image",
    )
    project.writeFile("src/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')
    project.writeFile(
      "src/panel.ts",
      'import image from "./logo.svg"; export default function Panel() { return image }',
    )
    expect(await buildPluginProject(project.root)).toBe(true)
    const manifest = PluginManifest.parse(await Bun.file(path.join(project.root, "dist/plugin.json")).json())
    const item = manifest.contributions.find((item) => item.kind === "ui.workbenchPanel")!
    const bundle = await import(path.join(project.root, "dist", item.component!.entry))
    const image = bundle[item.component!.exportName]()
    const resource = manifest.artifacts.ui?.resources?.find((resource) => resource.entry.endsWith(".svg"))
    if (!resource) throw new Error("Missing image resource")
    expect(image).toBe(new URL(resource.entry, `file://${project.root}/dist/`).href)
    expect(resource.sha256).toBe(sha256File(path.join(project.root, "dist", resource.entry)))
  } finally {
    project.cleanup()
  }
})

import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { buildPluginProject } from "../src/commands/build"
import { publishGeneration } from "../src/commands/dev"
import { packPluginProject } from "../src/commands/pack"

describe("plugin build and dev generations", () => {
  test("copies declared runtime assets and includes their content in the generation", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "asset-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src", "prompts"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "asset-fixture", version: "1.0.0", type: "module", source: "./src/index.ts" }),
      )
      fs.writeFileSync(path.join(root, "src", "prompts", "method.md"), "first prompt")
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { definePlugin } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "asset-fixture",
  version: "1.0.0",
  description: "Runtime asset fixture",
  assets: [{ source: "src/prompts", target: "runtime/prompts" }],
  contributions: [],
})
`,
      )

      expect(await buildPluginProject(root)).toBe(true)
      expect(fs.readFileSync(path.join(root, "dist", "runtime", "prompts", "method.md"), "utf8")).toBe("first prompt")
      const first = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf8")))

      fs.writeFileSync(path.join(root, "src", "prompts", "method.md"), "second prompt")
      expect(await buildPluginProject(root)).toBe(true)
      const second = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf8")))
      expect(second.artifacts.generation).not.toBe(first.artifacts.generation)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("compiled Solid UI remains reactive after asynchronous state changes", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "solid-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "solid-fixture", version: "1.0.0", type: "module", source: "./src/index.ts" }),
      )
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { definePlugin, workbenchPanel } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "solid-fixture",
  version: "1.0.0",
  description: "Reactive UI build fixture",
  contributions: [workbenchPanel({
    id: "panel",
    label: "Panel",
    surface: "side",
    cardinality: "singleton",
    component: { source: "src/panel.tsx" },
  })],
})
`,
      )
      fs.writeFileSync(
        path.join(root, "src", "panel.tsx"),
        `
import { For, createSignal } from "solid-js"
export default function Panel() {
  const [items, setItems] = createSignal<string[]>([])
  queueMicrotask(() => setItems(["alpha", "beta"]))
  return <ol data-count={items().length}><For each={items()}>{(item) => <li>{item}</li>}</For></ol>
}
`,
      )

      expect(await buildPluginProject(root)).toBe(true)
      const runner = path.join(root, "verify.mjs")
      fs.writeFileSync(
        runner,
        `
import { GlobalRegistrator } from ${JSON.stringify(import.meta.resolve("@happy-dom/global-registrator"))}
import * as solid from ${JSON.stringify(import.meta.resolve("solid-js/dist/solid.js"))}
import * as web from ${JSON.stringify(import.meta.resolve("solid-js/web/dist/web.js"))}
import * as store from ${JSON.stringify(import.meta.resolve("solid-js/store/dist/store.js"))}
GlobalRegistrator.register()
globalThis.__SYNERGY_PLUGIN_SOLID_RUNTIME__ = { solid, web, store }
const plugin = await import(${JSON.stringify(pathToFileURL(path.join(root, "dist", "ui", "index.js")).href)})
const target = document.createElement("div")
web.render(() => solid.createComponent(plugin.plugin_component_0, {}), target)
await new Promise((resolve) => setTimeout(resolve, 0))
if (target.textContent !== "alphabeta" || target.querySelector("ol")?.dataset.count !== "2") {
  throw new Error("Solid plugin UI did not react: " + target.outerHTML)
}
`,
      )
      const child = Bun.spawn([process.execPath, "--conditions=browser", runner], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("generates a manifest, advances the pointer atomically, and retains the last good generation", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "build-fixture",
          version: "1.0.0",
          type: "module",
          source: "./src/index.ts",
        }),
      )
      const source = path.join(root, "src", "index.ts")
      fs.writeFileSync(
        source,
        `
import { definePlugin, operation } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "build-fixture",
  version: "1.0.0",
  description: "Build fixture",
  contributions: [operation({
    id: "ping",
    type: "query",
    input: { type: "object" },
    output: { type: "object" },
    handler: async () => ({ pong: true }),
  })],
})
`,
      )
      expect(fs.existsSync(path.join(root, "plugin.json"))).toBe(false)
      expect(await publishGeneration(root)).toBe(true)
      const pointerPath = path.join(root, "dist", "dev", "current.json")
      const current = fs.readFileSync(pointerPath, "utf-8")
      const pointer = JSON.parse(current)
      const manifest = PluginManifest.parse(
        JSON.parse(fs.readFileSync(path.join(pointer.directory, "plugin.json"), "utf-8")),
      )
      expect(manifest.id).toBe("build-fixture")
      expect(manifest.contributions).toHaveLength(1)
      expect(manifest.artifacts.runtime?.entry).toBe("runtime/index.js")

      fs.writeFileSync(source, "export default @")
      expect(await publishGeneration(root)).toBe(false)
      expect(fs.readFileSync(pointerPath, "utf-8")).toBe(current)
      expect(fs.existsSync(pointer.directory)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("signs the generated plugin.json from a packed artifact", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "sign-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "sign-fixture", version: "1.0.0", type: "module", source: "./src/index.ts" }),
      )
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { definePlugin } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "sign-fixture",
  version: "1.0.0",
  description: "Signing fixture",
  contributions: [],
})
`,
      )

      expect(await buildPluginProject(root)).toBe(true)
      const archive = packPluginProject(root)
      const runner = path.join(root, "sign.mjs")
      fs.writeFileSync(
        runner,
        `
import { signPluginTarball } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "..", "src", "commands", "sign.ts")).href)}
await signPluginTarball(process.argv[2])
`,
      )
      const child = Bun.spawn([process.execPath, runner, archive], {
        cwd: root,
        env: { ...process.env, SYNERGY_HOME: path.join(root, "home") },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      const signature = JSON.parse(fs.readFileSync(`${archive}.sig`, "utf-8"))
      expect(signature.pluginId).toBe("sign-fixture")
      expect(signature.version).toBe("1.0.0")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

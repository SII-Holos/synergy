import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import Ajv2020 from "ajv/dist/2020"
import { buildPluginProject } from "../src/commands/build"
import { publishGeneration } from "../src/commands/dev"
import { packPluginProject } from "../src/commands/pack"
import { registryEntry } from "../src/lib/market-entry"
import { sha256File } from "../src/lib/crypto"

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

  test("compiles Zod schemas before crossing the definition loader boundary", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "zod-schema-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "zod-schema-fixture", version: "1.0.0", type: "module", source: "./src/index.ts" }),
      )
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { definePlugin, event, operation, tool } from "@ericsanchezok/synergy-plugin"
import z from "zod"
export default definePlugin({
  id: "zod-schema-fixture",
  version: "1.0.0",
  description: "Zod schema build fixture",
  contributions: [
    operation({
      id: "convert",
      type: "query",
      input: z.object({
        mode: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("text"), value: z.string().default("fallback") }),
          z.object({ kind: z.literal("count"), value: z.number() }),
        ]),
        tag: z.union([z.string(), z.number()]),
      }),
      output: z.object({ value: z.string().refine((value) => value.length > 0) }),
      handler: async () => ({ value: "ok" }),
    }),
    event({ id: "changed", payload: z.object({ value: z.union([z.string(), z.number()]) }) }),
    tool({
      id: "inspect",
      description: "Inspect a value",
      input: z.object({ value: z.string().default("fallback") }),
      handler: async () => "ok",
    }),
  ],
})
`,
      )

      expect(await buildPluginProject(root)).toBe(true)
      const manifest = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf8")))
      const operationContribution = manifest.contributions.find((item) => item.kind === "operation")
      const eventContribution = manifest.contributions.find((item) => item.kind === "event")
      const toolContribution = manifest.contributions.find((item) => item.kind === "tool")
      if (operationContribution?.kind !== "operation") throw new Error("Expected operation contribution")
      if (eventContribution?.kind !== "event") throw new Error("Expected event contribution")
      if (toolContribution?.kind !== "tool") throw new Error("Expected tool contribution")
      const ajv = new Ajv2020({ strict: false })
      expect(() => ajv.compile(operationContribution.input)).not.toThrow()
      expect(() => ajv.compile(operationContribution.output)).not.toThrow()
      expect(() => ajv.compile(eventContribution.payload)).not.toThrow()
      expect(() => ajv.compile(toolContribution.input)).not.toThrow()
      expect(operationContribution.input).toMatchObject({ type: "object" })
      expect(JSON.stringify(operationContribution.input)).toContain('"anyOf"')
      expect(JSON.stringify(operationContribution.input)).toContain('"default":"fallback"')
      expect(JSON.stringify(manifest.contributions)).not.toContain('"type":"union"')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects Zod transforms during manifest compilation", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "zod-transform-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "zod-transform-fixture", version: "1.0.0", type: "module", source: "./src/index.ts" }),
      )
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { definePlugin, operation } from "@ericsanchezok/synergy-plugin"
import z from "zod"
export default definePlugin({
  id: "zod-transform-fixture",
  version: "1.0.0",
  description: "Zod transform build fixture",
  contributions: [operation({
    id: "transform",
    type: "query",
    input: z.object({ value: z.string().transform((value) => value.trim()) }),
    output: z.object({ value: z.string() }),
    handler: async ({ value }) => ({ value }),
  })],
})
`,
      )

      expect(await buildPluginProject(root)).toBe(false)
      expect(fs.existsSync(path.join(root, "dist", "plugin.json"))).toBe(false)
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
import { capability, composerExtension, definePlugin, workbenchPanel } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "solid-fixture",
  version: "1.0.0",
  description: "Reactive UI build fixture",
  capabilities: [capability("composer.read")],
  contributions: [
    workbenchPanel({
      id: "panel",
      label: "Panel",
      surface: "side",
      cardinality: "singleton",
      component: { source: "src/panel.tsx" },
    }),
    composerExtension({
      id: "composer",
      requires: ["composer.read"],
      component: { source: "src/panel.tsx" },
    }),
  ],
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
      const manifest = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf8")))
      expect(manifest.contributions[1]).toMatchObject({
        kind: "ui.composerExtension",
        component: { entry: "ui/index.js", exportName: "plugin_component_1" },
      })
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

  test("builds valid local and OAuth remote MCP declarations", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "mcp-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "mcp-fixture", version: "1.0.0", type: "module", source: "./src/index.ts" }),
      )
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { definePlugin, mcp } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "mcp-fixture",
  version: "1.0.0",
  description: "MCP build fixture",
  contributions: [
    mcp({ id: "local", server: { type: "local", command: ["bunx", "example-mcp"], startup: "manual" } }),
    mcp({
      id: "remote",
      server: {
        type: "remote",
        url: "http://127.0.0.1:43123/mcp",
        oauth: { scope: "mcp:connect" },
        startup: "eager",
        retry: { maxAttempts: 3 },
      },
    }),
  ],
})
`,
      )

      expect(await buildPluginProject(root)).toBe(true)
      const manifest = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf8")))
      expect(manifest.contributions).toEqual([
        expect.objectContaining({ kind: "mcp", id: "local", server: expect.objectContaining({ type: "local" }) }),
        expect.objectContaining({ kind: "mcp", id: "remote", server: expect.objectContaining({ type: "remote" }) }),
      ])
      expect(manifest.artifacts.runtime).toBeUndefined()
      expect(fs.existsSync(path.join(root, "dist", "runtime", "index.js"))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects an invalid MCP declaration before writing a manifest", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "invalid-mcp-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "invalid-mcp-fixture", version: "1.0.0", type: "module", source: "./src/index.ts" }),
      )
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { definePlugin, mcp } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "invalid-mcp-fixture",
  version: "1.0.0",
  description: "Invalid MCP build fixture",
  contributions: [mcp({ id: "remote", server: { type: "remote", url: "file:///tmp/mcp.sock" } as never })],
})
`,
      )

      expect(await buildPluginProject(root)).toBe(false)
      expect(fs.existsSync(path.join(root, "dist", "plugin.json"))).toBe(false)
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

  test("builds an executable cli.command into runtime and manifest artifacts", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "cli-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "cli-fixture", version: "1.0.0", type: "module", source: "./src/index.ts" }),
      )
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { cliCommand, definePlugin } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "cli-fixture",
  version: "1.0.0",
  description: "Executable CLI fixture",
  capabilities: [{ id: "shell.execute" }],
  contributions: [cliCommand({
    id: "setup",
    description: "Configure the plugin",
    options: {
      force: { type: "boolean", description: "Replace existing configuration" },
      profile: { type: "string", description: "Profile to configure" },
      retries: { type: "number", description: "Maximum retry count" },
    },
    timeoutMs: 30_000,
    requires: ["shell.execute"],
    handler: async () => ({ exitCode: 0, stdout: "configured", stderr: "" }),
  })],
})
`,
      )

      expect(await buildPluginProject(root)).toBe(true)
      const manifest = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf8")))
      expect(manifest.artifacts.runtime?.entry).toBe("runtime/index.js")
      expect(fs.existsSync(path.join(root, "dist", "runtime", "index.js"))).toBe(true)
      expect(manifest.contributions as unknown).toEqual([
        {
          kind: "cli.command",
          id: "setup",
          description: "Configure the plugin",
          options: {
            force: { type: "boolean", description: "Replace existing configuration" },
            profile: { type: "string", description: "Profile to configure" },
            retries: { type: "number", description: "Maximum retry count" },
          },
          timeoutMs: 30_000,
          requires: ["shell.execute"],
        },
      ])
      expect(JSON.stringify(manifest)).not.toContain("handler")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("writes registry v2 access and compatibility metadata without risk ratings", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "capability-access-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "capability-access-fixture",
          version: "1.0.0",
          type: "module",
          source: "./src/index.ts",
        }),
      )
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { definePlugin } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "capability-access-fixture",
  name: "Capability Risk Fixture",
  version: "1.0.0",
  description: "Capability access fixture",
  compatibility: { synergy: ">=3.1.0" },
  capabilities: [{ id: "asset.write" }, { id: "shell.execute" }],
  contributions: [{
    kind: "tool",
    id: "create_attachment",
    description: "Create an attachment when the user asks for one.",
    input: { type: "object", properties: {} },
    async handler() { return "created" },
  }],
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

      const entry = registryEntry({
        tarballPath: archive,
        repo: "https://example.com/synergy/capability-access-fixture",
        downloadUrl: "https://example.com/capability-access-fixture.tgz",
        signatureUrl: "https://example.com/capability-access-fixture.tgz.sig",
        publishedAt: "2026-07-22T00:00:00.000Z",
      })
      expect(entry.schemaVersion).toBe(2)
      expect(entry.name).toBe("capability-access-fixture")
      expect(entry.compatibility).toEqual({ synergy: ">=3.1.0" })
      expect(entry.versions[0]).toMatchObject({
        apiVersion: "4.0",
        compatibility: { synergy: ">=3.1.0" },
      })
      expect(entry.versions[0]).not.toHaveProperty("risk")
      expect(entry.versions[0]?.featuresSummary).toEqual([
        {
          key: "tool:create_attachment",
          title: "create_attachment",
          description: "Create an attachment when the user asks for one.",
        },
      ])
      expect(entry.versions[0]?.permissionsSummary).toEqual([
        expect.objectContaining({ key: "asset.write", title: "Create attachments" }),
        expect.objectContaining({ key: "shell.execute", title: "Run declared setup commands" }),
      ])
      expect(JSON.stringify(entry)).not.toContain('"risk"')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("extracts imported CSS into a sibling stylesheet asset of the UI bundle", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "ui-css-fixture-"))
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "ui-css-fixture", version: "1.0.0", type: "module", source: "./src/index.ts" }),
      )
      fs.writeFileSync(
        path.join(root, "src", "index.ts"),
        `
import { definePlugin, workbenchPanel } from "@ericsanchezok/synergy-plugin"
export default definePlugin({
  id: "ui-css-fixture",
  version: "1.0.0",
  description: "UI CSS build fixture",
  contributions: [
    workbenchPanel({
      id: "panel",
      label: "Panel",
      surface: "side",
      cardinality: "singleton",
      component: { source: "src/panel.tsx" },
    }),
  ],
})
`,
      )
      fs.writeFileSync(
        path.join(root, "src", "panel.tsx"),
        `
import "./panel.css"
export default function Panel() {
  return <div class="ui-css-fixture-panel">styled</div>
}
`,
      )
      fs.writeFileSync(path.join(root, "src", "panel.css"), ".ui-css-fixture-panel { color: rgb(1, 2, 3); }\n")

      expect(await buildPluginProject(root)).toBe(true)
      const jsPath = path.join(root, "dist", "ui", "index.js")
      const cssPath = path.join(root, "dist", "ui", "index.css")
      expect(fs.existsSync(jsPath)).toBe(true)
      expect(fs.existsSync(cssPath)).toBe(true)
      const source = fs.readFileSync(jsPath, "utf8")
      expect(source).not.toContain("panel.css")
      expect(source).not.toContain("<style")
      expect(fs.readFileSync(cssPath, "utf8")).toContain(".ui-css-fixture-panel")

      const manifest = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf8")))
      expect(manifest.artifacts.ui?.entry).toBe("ui/index.js")
      expect(manifest.artifacts.ui?.sha256).toBe(sha256File(jsPath))

      fs.writeFileSync(path.join(root, "src", "panel.css"), ".ui-css-fixture-panel { color: rgb(9, 8, 7); }\n")
      expect(await buildPluginProject(root)).toBe(true)
      const second = PluginManifest.parse(JSON.parse(fs.readFileSync(path.join(root, "dist", "plugin.json"), "utf8")))
      expect(second.artifacts.generation).not.toBe(manifest.artifacts.generation)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

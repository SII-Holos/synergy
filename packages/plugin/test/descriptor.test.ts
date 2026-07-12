import { describe, expect, test } from "bun:test"
import z from "zod"
import {
  PLUGIN_API_VERSION,
  PluginManifest,
  capability,
  compilePluginManifest,
  definePlugin,
  event,
  hasUnlinkedSolidRuntimeImport,
  hasUnsupportedSolidRuntimeImport,
  operation,
  settings,
  rewritePluginSolidImports,
  tool,
  workbenchPanel,
} from "../src/index"

describe("definePlugin", () => {
  test("binds supported Solid imports to the host runtime and rejects alternate runtimes", () => {
    const source = [
      'import { createSignal } from "solid-js"',
      'import { insert, template } from "solid-js/web"',
      'import { createStore } from "solid-js/store"',
    ].join("\n")
    expect(hasUnlinkedSolidRuntimeImport(source)).toBe(true)
    const linked = rewritePluginSolidImports(source)
    expect(hasUnlinkedSolidRuntimeImport(linked)).toBe(false)
    expect(hasUnsupportedSolidRuntimeImport('import { jsx } from "solid-js/h/jsx-runtime"')).toBe(true)
  })

  test("compiles one source descriptor into a serializable manifest", () => {
    const plugin = definePlugin({
      id: "research",
      name: "Research",
      version: "1.2.3",
      description: "Research workflow",
      capabilities: [capability("workspace.read")],
      contributions: [
        operation({
          id: "graph.get",
          type: "query",
          input: z.object({ revision: z.number().int().optional() }),
          output: z.object({ active: z.string().nullable() }),
          requires: ["workspace.read"],
          handler: async () => ({ active: null }),
        }),
        event({
          id: "graph.changed",
          payload: z.object({ revision: z.number().int() }),
        }),
        workbenchPanel({
          id: "graph",
          label: "Research",
          surface: "side",
          cardinality: "singleton",
          defaultResource: { id: "map", title: "Research map", state: { view: "map" } },
          component: { source: "./src/ui.tsx", exportName: "ResearchPanel" },
        }),
      ],
    })

    const manifest = compilePluginManifest(plugin, {
      generation: "generation-1",
      runtime: { entry: "runtime/index.js", sha256: "runtime-hash" },
      ui: { entry: "ui/index.js", sha256: "ui-hash" },
    })

    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION)
    expect(manifest.id).toBe("research")
    expect(manifest.capabilities).toEqual([{ id: "workspace.read" }])
    expect(manifest.contributions.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "operation:graph.get",
      "event:graph.changed",
      "ui.workbenchPanel:graph",
    ])
    expect(manifest.contributions[0]).toMatchObject({
      kind: "operation",
      type: "query",
      expose: ["ui"],
      requires: ["workspace.read"],
      input: { type: "object" },
      output: { type: "object" },
    })
    expect(manifest.contributions[2]).toMatchObject({
      defaultResource: { id: "map", title: "Research map", state: { view: "map" } },
      component: { entry: "ui/index.js", exportName: "ResearchPanel" },
    })
    expect(JSON.stringify(manifest)).not.toContain("handler")
    expect(JSON.stringify(manifest)).not.toContain("src/ui.tsx")
  })

  test("compiles setting-gated tools against a declared setting", () => {
    const plugin = definePlugin({
      id: "diagnostics",
      version: "1.0.0",
      description: "Setting-gated diagnostics",
      contributions: [
        tool({
          id: "inspect",
          description: "Inspect diagnostics",
          input: z.object({}),
          enabledWhen: { setting: "diagnosticsEnabled", equals: true },
          handler: async () => "ok",
        }),
        settings({
          id: "settings",
          label: "Diagnostics",
          group: "Plugins",
          formSchema: {
            type: "object",
            properties: { diagnosticsEnabled: { type: "boolean", default: false } },
            additionalProperties: false,
          },
        }),
      ],
    })

    const manifest = compilePluginManifest(plugin, {
      generation: "generation-1",
      runtime: { entry: "runtime/index.js", sha256: "runtime-hash" },
    })
    expect(manifest.contributions[0]).toMatchObject({
      kind: "tool",
      enabledWhen: { setting: "diagnosticsEnabled", equals: true },
    })
  })

  test("rejects a tool condition that references an undeclared setting", () => {
    expect(() =>
      definePlugin({
        id: "diagnostics",
        version: "1.0.0",
        description: "Invalid setting condition",
        contributions: [
          tool({
            id: "inspect",
            description: "Inspect diagnostics",
            input: z.object({}),
            enabledWhen: { setting: "missing", equals: true },
            handler: async () => "ok",
          }),
        ],
      }),
    ).toThrow('Tool contribution "inspect" references undeclared setting "missing"')
  })

  test("rejects plugin tools without a top-level object schema", () => {
    const plugin = definePlugin({
      id: "invalid-schema",
      version: "1.0.0",
      description: "Invalid tool schema",
      contributions: [
        tool({
          id: "broken",
          description: "Broken tool",
          input: { type: "string" },
          handler: async () => "ok",
        }),
      ],
    })
    expect(() =>
      PluginManifest.parse(
        compilePluginManifest(plugin, {
          generation: "generation-1",
          runtime: { entry: "runtime/index.js", sha256: "runtime-hash" },
        }),
      ),
    ).toThrow("Plugin tool input must be a top-level JSON Schema object")
  })

  test("rejects duplicate contribution ids", () => {
    expect(() =>
      definePlugin({
        id: "duplicate",
        version: "1.0.0",
        description: "Duplicate contribution test",
        contributions: [
          event({ id: "changed", payload: z.object({}) }),
          event({ id: "changed", payload: z.object({}) }),
        ],
      }),
    ).toThrow('Duplicate plugin contribution id "changed"')
  })

  test("rejects undeclared contribution capabilities", () => {
    expect(() =>
      definePlugin({
        id: "capability-test",
        version: "1.0.0",
        description: "Capability test",
        contributions: [
          operation({
            id: "read",
            type: "query",
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            requires: ["session.read"],
            handler: async () => ({ ok: true }),
          }),
        ],
      }),
    ).toThrow('Contribution "read" requires undeclared capability "session.read"')
  })

  test("executable handler ids are derived from the flat contribution list", () => {
    const plugin = definePlugin({
      id: "handlers",
      version: "1.0.0",
      description: "Handler discovery",
      contributions: [
        tool({
          id: "echo",
          description: "Echo input",
          input: z.object({ value: z.string() }),
          handler: async ({ value }) => ({ output: value }),
        }),
        event({ id: "changed", payload: z.object({}) }),
      ],
    })

    expect(plugin.handlerIds).toEqual(["tool:echo"])
  })

  test("normalizes omitted assets and rejects duplicate package targets", () => {
    const plugin = definePlugin({
      id: "assets",
      version: "1.0.0",
      description: "Asset declaration test",
      contributions: [],
    })
    expect(plugin.assets).toEqual([])

    expect(() =>
      definePlugin({
        id: "duplicate-assets",
        version: "1.0.0",
        description: "Duplicate asset target test",
        assets: [
          { source: "prompts/one", target: "runtime/prompts" },
          { source: "prompts/two", target: "./runtime/prompts" },
        ],
        contributions: [],
      }),
    ).toThrow('Duplicate plugin asset target "runtime/prompts"')
  })
})

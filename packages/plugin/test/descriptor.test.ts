import { describe, expect, test } from "bun:test"
import z from "zod"
import {
  PLUGIN_API_VERSION,
  capability,
  compilePluginManifest,
  definePlugin,
  event,
  hasUnlinkedSolidRuntimeImport,
  hasUnsupportedSolidRuntimeImport,
  operation,
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
      component: { entry: "ui/index.js", exportName: "ResearchPanel" },
    })
    expect(JSON.stringify(manifest)).not.toContain("handler")
    expect(JSON.stringify(manifest)).not.toContain("src/ui.tsx")
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
})

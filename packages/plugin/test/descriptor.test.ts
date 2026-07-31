import { describe, expect, test } from "bun:test"
import z from "zod"
import {
  PLUGIN_API_VERSION,
  PluginManifest,
  capability,
  composerExtension,
  compilePluginManifest,
  definePlugin,
  event,
  hasUnlinkedSolidRuntimeImport,
  hasUnsupportedSolidRuntimeImport,
  operation,
  messageSlot,
  messageRenderer,
  hook,
  selectionExtension,
  settings,
  rewritePluginSolidImports,
  tool,
  textAction,
  workbenchPanel,
  mcp,
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

  test("targets one host tool with a trusted message renderer", () => {
    const plugin = definePlugin({
      id: "correction-card",
      version: "1.0.0",
      description: "Targeted correction card",
      contributions: [
        tool({
          id: "record",
          description: "Record the correction",
          input: z.object({}),
          handler: async () => "ok",
        }),
        messageRenderer({
          id: "correction",
          label: "Correction",
          messageType: "tool",
          tool: "plugin__correction-card__record",
          component: { source: "./src/correction.tsx" },
        }),
      ],
    })
    const manifest = compilePluginManifest(plugin, {
      generation: "generation-one",
      ui: { entry: "ui/index.js", sha256: "ui-hash" },
    })
    expect(manifest.contributions).toEqual([
      expect.objectContaining({
        kind: "tool",
        id: "record",
      }),
      expect.objectContaining({
        kind: "ui.messageRenderer",
        id: "correction",
        messageType: "tool",
        tool: "plugin__correction-card__record",
        component: {
          entry: "ui/index.js",
          exportName: expect.any(String),
        },
      }),
    ])
  })

  test("validates metadata-only Tool renderer ownership", () => {
    const plugin = definePlugin({
      id: "correction-card",
      version: "1.0.0",
      description: "Targeted correction card",
      contributions: [
        tool({
          id: "record",
          description: "Record the correction",
          input: z.object({}),
          handler: async () => "ok",
        }),
        messageRenderer({
          id: "correction",
          label: "Correction",
          messageType: "tool",
          tool: "plugin__correction-card__record",
          component: { source: "./src/correction.tsx" },
        }),
      ],
    })
    const manifest = compilePluginManifest(plugin, {
      generation: "generation-one",
      runtime: { entry: "runtime/index.js", sha256: "a".repeat(64) },
      ui: { entry: "ui/index.js", sha256: "b".repeat(64) },
    })

    const foreign = structuredClone(manifest)
    const foreignRenderer = foreign.contributions.find((item) => item.kind === "ui.messageRenderer")
    if (!foreignRenderer || foreignRenderer.kind !== "ui.messageRenderer") throw new Error("Missing renderer")
    foreignRenderer.tool = "plugin__another-plugin__record"
    expect(PluginManifest.safeParse(foreign).success).toBe(false)

    const missing = structuredClone(manifest)
    missing.contributions = missing.contributions.filter((item) => item.kind !== "tool")
    expect(PluginManifest.safeParse(missing).success).toBe(false)

    const unbound = structuredClone(manifest)
    const unboundRenderer = unbound.contributions.find((item) => item.kind === "ui.messageRenderer")
    if (!unboundRenderer || unboundRenderer.kind !== "ui.messageRenderer") throw new Error("Missing renderer")
    delete unboundRenderer.tool
    expect(PluginManifest.safeParse(unbound).success).toBe(false)

    const hostPart = structuredClone(manifest)
    const hostPartRenderer = hostPart.contributions.find((item) => item.kind === "ui.messageRenderer")
    if (!hostPartRenderer || hostPartRenderer.kind !== "ui.messageRenderer") throw new Error("Missing renderer")
    hostPartRenderer.messageType = "text"
    delete hostPartRenderer.tool
    expect(PluginManifest.safeParse(hostPart).success).toBe(false)
  })

  test("rejects message renderers that omit Tool ownership or replace host parts", () => {
    const unsafe = (messageType: string, toolName?: string) =>
      definePlugin({
        id: "correction-card",
        version: "1.0.0",
        description: "Unsafe host renderer replacement",
        contributions: [
          messageRenderer({
            id: "correction",
            label: "Correction",
            messageType,
            ...(toolName ? { tool: toolName } : {}),
            component: { source: "./src/correction.tsx" },
          }),
        ],
      })

    expect(() => unsafe("tool")).toThrow("must target a Tool contributed by the same plugin")
    expect(() => unsafe("text")).toThrow("cannot replace a host-owned message type")
    expect(() => unsafe("custom:correction", "plugin__correction-card__record")).toThrow(
      "cannot replace a host-owned message type",
    )
  })

  test("rejects a message renderer that tries to replace another tool", () => {
    expect(() =>
      definePlugin({
        id: "correction-card",
        version: "1.0.0",
        description: "Unsafe targeted renderer",
        contributions: [
          messageRenderer({
            id: "correction",
            label: "Correction",
            messageType: "tool",
            tool: "plugin__another-plugin__record",
            component: { source: "./src/correction.tsx" },
          }),
        ],
      }),
    ).toThrow("must target a Tool contributed by the same plugin")
  })

  test("compiles setting-gated MCP servers against a declared setting", () => {
    const plugin = definePlugin({
      id: "frontend-kit",
      version: "1.0.0",
      description: "Setting-gated MCP servers",
      contributions: [
        mcp({
          id: "components",
          enabledWhen: { setting: "componentsEnabled", equals: true },
          server: { type: "local", command: ["frontend-mcp"], startup: "eager" },
        }),
        settings({
          id: "settings",
          label: "Frontend Kit",
          group: "Plugins",
          formSchema: {
            type: "object",
            properties: { componentsEnabled: { type: "boolean", default: true } },
            additionalProperties: false,
          },
        }),
      ],
    })

    const manifest = compilePluginManifest(plugin, { generation: "generation-1" })
    expect(manifest.contributions[0]).toMatchObject({
      kind: "mcp",
      enabledWhen: { setting: "componentsEnabled", equals: true },
      server: { startup: "eager" },
    })
  })

  test.each([
    [
      "Tool",
      tool({
        id: "inspect",
        description: "Inspect diagnostics",
        input: z.object({}),
        enabledWhen: { setting: "missing", equals: true },
        handler: async () => "ok",
      }),
    ],
    [
      "MCP",
      mcp({
        id: "components",
        enabledWhen: { setting: "missing", equals: true },
        server: { type: "local", command: ["frontend-mcp"] },
      }),
    ],
  ])(
    "rejects a %s condition that references an undeclared setting",
    (kind: string, contribution: ReturnType<typeof tool> | ReturnType<typeof mcp>) => {
      expect(() =>
        definePlugin({
          id: "diagnostics",
          version: "1.0.0",
          description: "Invalid setting condition",
          contributions: [contribution],
        }),
      ).toThrow(`${kind} contribution \"${contribution.id}\" references undeclared setting \"missing\"`)
    },
  )

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
    ).toThrow('Duplicate plugin contribution id "changed" for kind "event"')
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

  test("compiles headless interaction extensions and validates text action operations", () => {
    const plugin = definePlugin({
      id: "interaction",
      version: "1.0.0",
      description: "Interaction surfaces",
      capabilities: [capability("composer.read"), capability("selection.read")],
      contributions: [
        operation({
          id: "translate",
          type: "command",
          expose: ["ui"],
          input: z.object({
            selection: z.object({
              selectionId: z.string(),
              text: z.string(),
              source: z.enum(["document", "code", "terminal"]),
              origin: z.enum(["user_message", "assistant_message", "editable", "other"]),
              editable: z.boolean(),
              wholeContainer: z.boolean(),
            }),
          }),
          output: z.object({}),
          handler: async () => ({}),
        }),
        composerExtension({
          id: "composer",
          requires: ["composer.read"],
          component: { source: "src/composer.tsx" },
        }),
        selectionExtension({ id: "selection", component: { source: "src/selection.tsx" } }),
        textAction({
          id: "translate-action",
          label: "Translate",
          operation: "translate",
          when: {
            sources: ["document", "code"],
            origins: ["assistant_message", "other"],
            minChars: 1,
            maxChars: 4_000,
            editable: false,
          },
          presentation: {
            kind: "popover",
            width: "md",
            component: { source: "src/translation.tsx" },
          },
        }),
        messageSlot({ id: "message", slot: "message.after", component: { source: "src/message.tsx" } }),
      ],
    })
    const manifest = compilePluginManifest(plugin, {
      generation: "generation-1",
      runtime: { entry: "runtime/index.js", sha256: "a".repeat(64) },
      ui: {
        entry: "ui/index.js",
        sha256: "b".repeat(64),
        exports: {
          "ui.composerExtension:composer": "Composer",
          "ui.selectionExtension:selection": "Selection",
          "ui.textAction:translate-action": "Translation",
          "ui.messageSlot:message": "Message",
        },
      },
    })
    expect(() => PluginManifest.parse(manifest)).not.toThrow()
    expect(manifest.contributions.slice(1)).toMatchObject([
      { kind: "ui.composerExtension", order: 1000, component: { exportName: "Composer" } },
      { kind: "ui.selectionExtension", requires: ["selection.read"] },
      {
        kind: "ui.textAction",
        operation: "translate",
        requires: ["selection.read"],
        when: {
          sources: ["document", "code"],
          origins: ["assistant_message", "other"],
          minChars: 1,
          maxChars: 4_000,
          editable: false,
        },
        presentation: {
          kind: "popover",
          width: "md",
          component: { exportName: "Translation" },
        },
      },
      { kind: "ui.messageSlot", slot: "message.after", component: { exportName: "Message" } },
    ])

    expect(() =>
      definePlugin({
        id: "bad-action",
        version: "1.0.0",
        description: "Bad action",
        capabilities: [capability("selection.read")],
        contributions: [textAction({ id: "bad", label: "Bad", operation: "missing" })],
      }),
    ).toThrow("must reference a UI-exposed command operation")
  })

  test("requires the verified UI artifact for nested text-action presentation", () => {
    const plugin = definePlugin({
      id: "interaction",
      version: "1.0.0",
      description: "Interaction surfaces",
      capabilities: [capability("selection.read")],
      contributions: [
        operation({
          id: "translate",
          type: "command",
          expose: ["ui"],
          input: z.object({}),
          output: z.object({}),
          handler: async () => ({}),
        }),
        textAction({
          id: "translate-action",
          label: "Translate",
          operation: "translate",
          presentation: {
            kind: "popover",
            component: { source: "src/translation.tsx" },
          },
        }),
      ],
    })
    const manifest = compilePluginManifest(plugin, {
      generation: "generation-1",
      runtime: { entry: "runtime/index.js", sha256: "a".repeat(64) },
      ui: {
        entry: "ui/index.js",
        sha256: "b".repeat(64),
        exports: { "ui.textAction:translate-action": "Translation" },
      },
    })

    const missingArtifact = structuredClone(manifest)
    delete missingArtifact.artifacts.ui
    expect(PluginManifest.safeParse(missingArtifact).success).toBe(false)

    const mismatchedEntry = structuredClone(manifest)
    const action = mismatchedEntry.contributions.find((item) => item.kind === "ui.textAction")
    if (!action || action.kind !== "ui.textAction" || !action.presentation) {
      throw new Error("Missing text action presentation")
    }
    action.presentation.component.entry = "ui/unverified.js"
    expect(PluginManifest.safeParse(mismatchedEntry).success).toBe(false)
  })

  test("rejects invalid text-action bounds and Agent role allowlists", () => {
    expect(() =>
      definePlugin({
        id: "bad-bounds",
        version: "1.0.0",
        description: "Invalid text action bounds",
        capabilities: [capability("selection.read")],
        contributions: [
          operation({
            id: "translate",
            type: "command",
            expose: ["ui"],
            input: z.object({}),
            output: z.object({}),
            async handler() {
              return {}
            },
          }),
          textAction({
            id: "translate",
            label: "Translate",
            operation: "translate",
            when: { minChars: 10, maxChars: 2 },
          }),
        ],
      }),
    ).toThrow("minChars cannot exceed maxChars")

    expect(() =>
      definePlugin({
        id: "bad-roles",
        version: "1.0.0",
        description: "Invalid model roles",
        capabilities: [
          capability("agent.call", {
            modelRoles: ["mini", "provider-specific-model"],
          }),
        ],
        contributions: [],
      }),
    ).toThrow("unique PluginModelRole values")
  })

  test("requires session.read on persisted user message observers", () => {
    expect(() =>
      definePlugin({
        id: "message-observer",
        version: "1.0.0",
        description: "Message observer",
        capabilities: [capability("session.read")],
        contributions: [hook({ id: "observe", point: "session.user-message.after", handler: async () => undefined })],
      }),
    ).toThrow("requires session.read")
    expect(() =>
      definePlugin({
        id: "message-observer",
        version: "1.0.0",
        description: "Message observer",
        capabilities: [capability("session.read")],
        contributions: [
          hook({
            id: "observe",
            point: "session.user-message.after",
            requires: ["session.read"],
            handler: async () => undefined,
          }),
        ],
      }),
    ).not.toThrow()
  })
})

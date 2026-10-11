import { expect, test } from "bun:test"
import { z } from "zod"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { ToolDiscovery } from "../../src/tool/discovery"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ToolIntent } from "../../src/session/tool-intent"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { Environment } from "../../src/environment"
import { testRuntime } from "../support/runtime"
import { storageTestBackends } from "../support/storage-backends"

const backend = storageTestBackends().at(-1)!
const postgres = backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL! : undefined

const model = {
  id: "test-model",
  modelID: "test-model",
  providerID: "test-provider",
  api: { id: "test-model" },
  capabilities: { input: { image: false } },
} as any
const agent = Agent.Info.parse({
  name: "fixture",
  mode: "primary",
  options: {},
  controlProfile: "full_access",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
})

test("discovery and hidden availability do not load implementations; expansion uses the real schema", async () => {
  let imports = 0
  const lazy = Tool.lazy({ id: "lazy_fixture", requiresWorkspace: false }, async () => {
    imports++
    return Tool.define(
      "lazy_fixture",
      {
        description: "Read an exact revision",
        parameters: z.object({ workBrief: z.number(), revision: z.number().int().positive() }),
        async execute() {
          throw new Error("Resolution must not execute tools")
        },
      },
      { requiresWorkspace: false },
    )
  })
  await using runtime = await testRuntime({
    postgres,
    register() {
      ToolRegistry.registerToolProvider("lazy-fixture", () => [
        { ...lazy, catalogDescription: "Inspect a saved revision", exposure: { mode: "group", group: "lazy" } },
      ])
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspaceID: null })
        const input = { agent, model, session, sessionID: session.id, includeMCP: false }
        const catalog = await ToolDiscovery.collect({ ...input, providerID: model.providerID })
        expect(catalog.tools.find((x) => x.id === lazy.id)?.description).toBe("Inspect a saved revision")
        const hidden = await ToolResolver.availability(input)
        expect(imports).toBe(0)
        expect(hidden.autoExpandable.has(lazy.id)).toBe(true)
        expect(hidden.intentBindings?.has(lazy.id)).toBe(false)
        const expanded = await ToolResolver.autoExpandTool(
          { ...input, processor: { message: { id: "msg_lazy" } } as any },
          lazy.id,
        )
        expect(imports).toBe(1)
        expect(expanded?.inputSchema).toBeDefined()
        const binding = ToolIntent.snapshot(expanded!.inputSchema!)
        expect(binding.inputShape).toBe("envelope")
        expect(
          ToolIntent.decode(binding, { workBrief: "Inspect revision", toolInput: { workBrief: 7, revision: 2 } }).input,
        ).toEqual({ workBrief: 7, revision: 2 })
        expect(
          ToolResolver.validateToolInput(lazy.id, expanded!.inputSchema!, { workBrief: 7, revision: -1 }),
        ).toBeDefined()
        expect(await Environment.list(Scope.home().id)).toEqual([])
      },
    }),
  )
})

test("denied lazy tools stay unloaded and failed companions suppress the whole visible suite", async () => {
  let deniedImports = 0
  await using runtime = await testRuntime({
    postgres,
    register() {
      ToolRegistry.registerToolProvider("lazy-failures", () => [
        {
          ...Tool.lazy({ id: "denied_fixture" }, async () => {
            deniedImports++
            throw new Error("denied import")
          }),
          catalogDescription: "Denied",
          exposure: { mode: "resident" },
        },
        {
          ...Tool.lazy({ id: "failed_fixture" }, async () => {
            throw new Error("unavailable module")
          }),
          catalogDescription: "Unavailable",
          exposure: { mode: "resident" },
        },
        {
          ...Tool.define("dependent_fixture", {
            description: "Requires companion",
            parameters: z.object({}),
            async execute() {
              throw new Error("not callable")
            },
          }),
          exposure: { mode: "resident", companions: ["failed_fixture"] },
        },
      ])
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const result = await ToolResolver.availability({
          agent,
          model,
          sessionID: "ses_lazy",
          includeMCP: false,
          userTools: { denied_fixture: false },
        })
        expect(deniedImports).toBe(0)
        expect(
          result.visible.some((x) => ["denied_fixture", "failed_fixture", "dependent_fixture"].includes(x.id)),
        ).toBe(false)
        expect(result.diagnostics.has("failed_fixture")).toBe(true)
      },
    }),
  )
})

test("lazy imports are shared while each initialization retains its caller context", async () => {
  let imports = 0
  const lazy = Tool.lazy({ id: "context_fixture" }, async () => {
    imports++
    return Tool.define("context_fixture", async (context) => ({
      description: context?.agent?.name ?? "none",
      parameters: z.object({}),
      async execute() {
        return { title: "", output: "", metadata: {} }
      },
    }))
  })
  const result = await Promise.all([lazy.init({ agent }), lazy.init({ agent: { ...agent, name: "another" } })])
  expect(imports).toBe(1)
  expect(result.map((x) => x.description)).toEqual(["fixture", "another"])
})

test("a deferred implementation cannot add undeclared execution requirements", async () => {
  const lazy = Tool.lazy({ id: "mismatch_fixture", requiresWorkspace: false }, async () =>
    Tool.define(
      "mismatch_fixture",
      {
        description: "Execute",
        parameters: z.object({}),
        async execute() {
          throw new Error("never execute")
        },
      },
      { requiresExecution: "exec" },
    ),
  )
  await expect(lazy.init()).rejects.toThrow("declaration")
})

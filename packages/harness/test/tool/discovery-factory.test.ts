import { expect, test } from "bun:test"
import { ToolRegistry } from "../../src/tool/registry"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { z } from "zod"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session"
import { Tool } from "../../src/tool/tool"
import { ToolDiscovery } from "../../src/tool/discovery"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { Environment } from "../../src/environment"

test("discovery metadata uses the exact built-in definitions without a duplicate provider", async () => {
  const first = ToolRegistry.discoveryTools()
  const second = ToolRegistry.discoveryTools()
  expect(first.map((tool) => tool.id)).toEqual(["search_tools", "expand_tools"])
  expect(first[0]).toBe(second[0])
  expect(first[1]).toBe(second[1])
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        for (const tool of first) {
          const definition = await tool.init()
          expect(definition.description.length).toBeGreaterThan(0)
          expect(definition.parameters).toBeDefined()
          expect(typeof definition.execute).toBe("function")
        }
        expect(await ToolRegistry.ids()).toEqual(["search_tools", "expand_tools"])
        expect(ToolRegistry.toolProviderIDs()).toEqual([])
      },
    }),
  )
})

test.each([false, true])("discovery uses the Session Workspace without local compute: %s", async (selected) => {
  await using runtime = await testRuntime({
    register() {
      ToolRegistry.registerToolProvider("workspace-fixture", () => [
        Tool.define(
          "workspace_fixture",
          {
            description: "Read the selected Workspace",
            parameters: z.object({}),
            async execute() {
              throw new Error("Discovery must not execute tools")
            },
          },
          { requiresWorkspace: true, exposure: { mode: "group", group: "fixture" } },
        ),
      ])
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({
          scopeID: Scope.home().id,
          backend: { provider: "objects", spec: { blobStore: "fixture", virtualRoot: "/workspace" } },
        })
        const session = await Session.create({ workspaceID: selected ? workspace.id : null })
        const input = {
          providerID: "fixture",
          agent: Agent.Info.parse({ name: "fixture", mode: "primary", permission: [], options: {} }),
          session,
          includeMCP: false,
        }
        const catalog = await ToolDiscovery.collect(input)
        expect(catalog.tools.some((tool) => tool.id === "workspace_fixture")).toBe(selected)
        if (selected) {
          expect(ToolDiscovery.nonResidentEntries(catalog).some((tool) => tool.id === "workspace_fixture")).toBe(true)
          const disabled = await ToolDiscovery.collect({ ...input, userTools: { workspace_fixture: false } })
          expect(disabled.disabled.has("workspace_fixture")).toBe(true)
          expect(ToolDiscovery.nonResidentEntries(disabled).some((tool) => tool.id === "workspace_fixture")).toBe(false)
        }
        expect(ScopeContext.current.workspace).toBeNull()
        expect(await Environment.list(Scope.home().id)).toEqual([])
      },
    }),
  )
})

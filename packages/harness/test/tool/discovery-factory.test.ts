import { expect, test } from "bun:test"
import { ToolRegistry } from "../../src/tool/registry"
import { testRuntime } from "../support/runtime"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

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

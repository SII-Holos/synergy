import { describe, expect, test } from "bun:test"
import z from "zod"
import { ToolRegistry } from "../../src/tool/registry"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

describe.serial("tool schemas", () => {
  test("all registered tool parameter schemas can be represented as JSON Schema", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tools = await ToolRegistry.tools("test-provider")
        const failures: string[] = []

        for (const item of tools) {
          try {
            z.toJSONSchema(item.parameters)
          } catch (error) {
            failures.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        expect(failures).toEqual([])
      },
    })
  })
})

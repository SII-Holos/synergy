import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import z from "zod"
import { ToolRegistry } from "../../src/tool/registry"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe.serial("tool schemas", () => {
  beforeEach(() =>
    runtime.run(async () => {
      await ToolRegistry.state.resetAll()
    }),
  )

  afterEach(() =>
    runtime.run(async () => {
      await ToolRegistry.state.resetAll()
    }),
  )
  test("all registered tool parameter schemas can be represented as JSON Schema", () =>
    runtime.run(async () => {
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
    }))
})

afterRuntimeTests(() => runtime.close())

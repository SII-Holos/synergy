import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import z from "zod"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerLocalTools } from "../../src/register-tools"

interface Variant {
  properties?: { action?: { const?: string }; permission?: unknown }
}

function actionVariants(schema: Record<string, unknown>): Variant[] {
  const input = (schema.properties as Record<string, { anyOf?: Variant[]; oneOf?: Variant[] }> | undefined)?.input
  return input?.anyOf ?? input?.oneOf ?? []
}

describe.serial("runtime-local tool schemas", () => {
  beforeEach(async () => {
    await ToolRegistry.state.resetAll()
  })

  afterEach(async () => {
    await ToolRegistry.state.resetAll()
  })

  test("every registered tool parameter schema is representable as JSON Schema", async () => {
    registerLocalTools()
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tools = await ToolRegistry.tools("test-provider")
        const failures: string[] = []

        for (const item of tools) {
          if (item.inputSchema) continue
          try {
            expect(z.toJSONSchema(item.parameters).type).toBe("object")
          } catch (error) {
            failures.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        expect(tools.some((item) => item.id === "agent_config")).toBe(true)
        expect(failures).toEqual([])
      },
    })
  })

  test("agent_config JSON Schema exposes permission on create and update", async () => {
    registerLocalTools()
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const definition = await ToolRegistry.find("agent_config")
        expect(definition).toBeDefined()

        const schema = z.toJSONSchema(definition!.parameters) as Record<string, unknown>
        const variants = actionVariants(schema)
        const create = variants.find((variant) => variant.properties?.action?.const === "create")
        const update = variants.find((variant) => variant.properties?.action?.const === "update")

        for (const variant of [create, update]) {
          const permission = variant?.properties?.permission as { anyOf?: unknown[] } | undefined
          expect(permission).toBeDefined()
          expect(permission?.anyOf).toBeDefined()
        }
        expect(JSON.stringify(create?.properties?.permission)).toContain('"deny"')
        expect(JSON.stringify(schema)).not.toContain("__originalKeys")
      },
    })
  })
})

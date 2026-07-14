import { describe, expect, test } from "bun:test"
import z from "zod"
import { ToolResolver } from "../../src/session/tool-resolver"
import { ToolRegistry } from "../../src/tool/registry"

describe("plugin tool schemas", () => {
  test("uses the canonical manifest schema instead of converting the validation wrapper", () => {
    const canonical = {
      type: "object" as const,
      properties: { seed: { type: "string" as const } },
      required: ["seed"],
      additionalProperties: false,
    }
    expect(
      ToolResolver.registryInputSchema({
        parameters: z.custom(() => true),
        inputSchema: canonical,
      }),
    ).toEqual(canonical)
  })

  test("evaluates setting conditions without coercion", () => {
    const condition = { setting: "diagnosticsEnabled", equals: true }
    expect(ToolRegistry.matchesSettingCondition(condition, { diagnosticsEnabled: true })).toBe(true)
    expect(ToolRegistry.matchesSettingCondition(condition, { diagnosticsEnabled: false })).toBe(false)
    expect(ToolRegistry.matchesSettingCondition(condition, { diagnosticsEnabled: "true" })).toBe(false)
  })
})

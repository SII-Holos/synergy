import { describe, expect, test } from "bun:test"
import { ToolCatalog } from "../../src/session/tool-catalog"

describe("ToolCatalog", () => {
  test("serializes the same authorized definitions identically regardless of arrival order", () => {
    const definitions = ["zeta", "mcp__Z__read", "Alpha", "mcp__a__read"].map((id) => ({
      id,
      description: id,
      inputSchema: { type: "object" as const, properties: {} },
    }))
    const original = structuredClone(definitions)
    const first = ToolCatalog.modelTools(definitions)
    expect(Object.keys(first)).toEqual(["Alpha", "mcp__Z__read", "mcp__a__read", "zeta"])
    expect(JSON.stringify(ToolCatalog.modelTools(definitions.toReversed()))).toBe(JSON.stringify(first))
    expect(definitions).toEqual(original)
    expect(Object.keys(ToolCatalog.modelTools(definitions.slice(1)))).not.toContain("zeta")
  })

  test("builds model-facing tools without executable callbacks", () => {
    const tools = ToolCatalog.modelTools([
      {
        id: "probe",
        description: "Inspect a value",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ])

    expect(Object.keys(tools)).toEqual(["probe"])
    expect(tools.probe.description).toBe("Inspect a value")
    expect(tools.probe.execute).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import { ToolCatalog } from "../../src/session/tool-catalog"

describe("ToolCatalog", () => {
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

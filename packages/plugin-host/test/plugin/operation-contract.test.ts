import { describe, expect, test } from "bun:test"
import { PluginOperationError, resolvePluginOperation, validatePluginOperationValue } from "../../src/plugin/operation"

const manifest = {
  contributions: [
    { kind: "operation", id: "ui.query", expose: ["ui"] as Array<"ui" | "sdk"> },
    { kind: "operation", id: "public.query", expose: ["ui", "sdk"] as Array<"ui" | "sdk"> },
  ],
}

describe("plugin operation contract", () => {
  test("rejects SDK calls to UI-only operations", () => {
    expect(() => resolvePluginOperation(manifest, "ui.query", "sdk")).toThrow(PluginOperationError)
    try {
      resolvePluginOperation(manifest, "ui.query", "sdk")
    } catch (error) {
      expect((error as PluginOperationError).code).toBe("CAPABILITY_DENIED")
    }
    expect(resolvePluginOperation(manifest, "public.query", "sdk").id).toBe("public.query")
  })

  test("validates both request and response schemas with stable error codes", () => {
    const schema = {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
      additionalProperties: false,
    }
    expect(() => validatePluginOperationValue(schema, {}, "INPUT_INVALID")).toThrow(PluginOperationError)
    try {
      validatePluginOperationValue(schema, { name: 3 }, "OUTPUT_INVALID")
    } catch (error) {
      expect((error as PluginOperationError).code).toBe("OUTPUT_INVALID")
    }
    expect(validatePluginOperationValue(schema, { name: "valid" }, "INPUT_INVALID")).toBeUndefined()
  })
})

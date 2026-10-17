import { describe, expect, test } from "bun:test"
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js"
import { modelDescription } from "../../src/model-descriptions"
import anysearch from "../fixtures/anysearch-tools.json"
import scholight from "../fixtures/scholight-tools.json"

const builtin = { name: "anysearch", source: "builtin", url: "https://api.anysearch.com/mcp" }

describe("reviewed built-in MCP descriptions", () => {
  for (const raw of anysearch) {
    test(`${raw.name}: only the reviewed builtin definition gets a shorter model description`, () => {
      const definition = ToolSchema.parse(raw)
      const original = structuredClone(definition)
      const result = modelDescription(builtin, definition)
      expect(result.changed).toBeUndefined()
      expect(result.description.length).toBeLessThan(definition.description!.length)
      expect(definition).toEqual(original)
      for (const source of ["config", "plugin", "runtime"])
        expect(modelDescription({ ...builtin, source }, definition).description).toBe(definition.description!)
      expect(modelDescription({ ...builtin, url: "https://custom.invalid/mcp" }, definition).description).toBe(
        definition.description!,
      )
      const reordered = Object.fromEntries(Object.entries(definition).reverse())
      expect(modelDescription(builtin, ToolSchema.parse(reordered))).toEqual(result)
      for (const changed of [
        { ...definition, description: `${definition.description}\nNew contract.` },
        { ...definition, inputSchema: { ...definition.inputSchema, required: ["new_required"] } },
        { ...definition, annotations: { ...definition.annotations, readOnlyHint: false } },
        { ...definition, outputSchema: { type: "object" as const, properties: { result: { type: "number" } } } },
      ]) {
        const fallback = modelDescription(builtin, changed)
        expect(fallback.description).toBe(changed.description!)
        expect(fallback.changed).toMatch(/^[a-f0-9]{64}$/)
      }
      for (const name of ["future_tool", "__proto__", "constructor", "toString"]) {
        const unknown = { ...definition, name }
        expect(modelDescription(builtin, unknown)).toEqual({ description: unknown.description! })
      }
    })
  }

  test("Scholight's concise contracts remain intact, including search modes and cursor-only extraction", () => {
    for (const raw of scholight) {
      const definition = ToolSchema.parse(raw)
      expect(
        modelDescription(
          { name: "scholight", source: "builtin", url: "https://scholight.sanchezcloud.net/api/mcp" },
          definition,
        ),
      ).toEqual({ description: definition.description! })
    }
  })
})

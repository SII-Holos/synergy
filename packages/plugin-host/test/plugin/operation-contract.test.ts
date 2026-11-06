import { describe, expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, operation, PluginManifest } from "@ericsanchezok/synergy-plugin"
import { z } from "zod"
import { PluginOperationError, resolvePluginOperation, validatePluginOperationValue } from "../../src/plugin/operation"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const manifest = {
  contributions: [
    { kind: "operation", id: "ui.query", expose: ["ui"] as Array<"ui" | "sdk"> },
    { kind: "operation", id: "public.query", expose: ["ui", "sdk"] as Array<"ui" | "sdk"> },
  ],
}

describe("plugin operation contract", () => {
  test("rejects SDK calls to UI-only operations", () =>
    runtime.run(() => {
      expect(() => resolvePluginOperation(manifest, "ui.query", "sdk")).toThrow(PluginOperationError)
      try {
        resolvePluginOperation(manifest, "ui.query", "sdk")
      } catch (error) {
        expect((error as PluginOperationError).code).toBe("CAPABILITY_DENIED")
      }
      expect(resolvePluginOperation(manifest, "public.query", "sdk").id).toBe("public.query")
    }))

  test("validates both request and response schemas with stable error codes", () =>
    runtime.run(() => {
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
    }))

  test("generated manifest references enforce operation input and recursive output constraints", () =>
    runtime.run(() => {
      const shared = z.strictObject({ value: z.string() })
      const tree = z.strictObject({
        value: z.string(),
        get children() {
          return z.array(tree)
        },
      })
      const input = z.toJSONSchema(z.strictObject({ first: shared, second: shared }), {
        target: "draft-2020-12",
        io: "input",
        reused: "ref",
      })
      const plugin = definePlugin({
        id: "reference-fixture",
        version: "1.0.0",
        description: "Generated reference validation fixture",
        contributions: [
          operation({
            id: "inspect",
            type: "query",
            input,
            output: tree,
            handler: async () => ({ value: "root", children: [] }),
          }),
        ],
      })
      const manifest = PluginManifest.parse(
        JSON.parse(
          JSON.stringify(
            compilePluginManifest(plugin, {
              generation: "fixture",
              runtime: { entry: "runtime/index.js", sha256: "0".repeat(64) },
            }),
          ),
        ),
      )
      const contribution = resolvePluginOperation(manifest, "inspect", "ui")
      for (const [schema, valid, invalid, code] of [
        [
          contribution.input,
          { first: { value: "a" }, second: { value: "b" } },
          { first: { value: "a" }, second: { value: 3 } },
          "INPUT_INVALID",
        ],
        [
          contribution.output,
          { value: "root", children: [{ value: "child", children: [] }] },
          { value: "root", children: [{ value: 3, children: [] }] },
          "OUTPUT_INVALID",
        ],
      ] as const) {
        expect(validatePluginOperationValue(schema, valid, code)).toBeUndefined()
        expect(() => validatePluginOperationValue(schema, invalid, code)).toThrow(PluginOperationError)
        try {
          validatePluginOperationValue(schema, invalid, code)
        } catch (error) {
          expect(error).toBeInstanceOf(PluginOperationError)
          if (!(error instanceof PluginOperationError)) throw error
          expect(error.code).toBe(code)
          expect(error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ keyword: "type" })]))
        }
      }
    }))
})

afterRuntimeTests(() => runtime.close())

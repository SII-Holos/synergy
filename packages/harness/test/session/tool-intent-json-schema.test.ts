import { expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import type { JSONSchema7 } from "ai"
import { z } from "zod"
import type { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ToolIntent } from "../../src/session/tool-intent"
import { ToolResolver } from "../../src/session/tool-resolver"

function model(providerID: string): Provider.Model {
  return {
    id: "reference-fixture",
    providerID,
    api: { id: providerID === "google" ? "gemini-fixture" : "reference-fixture", url: "", npm: "" },
    name: "Reference fixture",
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1000, output: 100 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-10-07",
  }
}

function verify(schema: z.ZodType, providerID: string, shape: ToolIntent.Shape, valid: unknown, invalid: unknown[]) {
  return verifyGenerated(
    z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", reused: "ref" }),
    providerID,
    shape,
    valid,
    invalid,
  )
}

function verifyGenerated(
  generated: z.core.JSONSchema.BaseSchema,
  providerID: string,
  shape: ToolIntent.Shape,
  valid: unknown,
  invalid: unknown[],
) {
  const transformed = ProviderTransform.schema(model(providerID), generated, { tool: "reference-fixture" })
  const binding = ToolIntent.snapshot(transformed as JSONSchema7)
  expect(binding.inputShape).toBe(shape)
  const nativeValidate = new Ajv2020({ allErrors: true, strict: false }).compile(binding.nativeSchema)
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(binding.schema)
  const encoded = ToolIntent.encode(valid, "Inspect generated references", shape)
  expect(nativeValidate(valid)).toBe(true)
  expect(validate(encoded)).toBe(true)
  expect(ToolIntent.decode(binding, encoded).input).toEqual(valid)
  expect(ToolResolver.validateToolInput("reference-fixture", binding.schema, encoded)).toBeUndefined()
  for (const value of invalid) {
    const encodedInvalid = ToolIntent.encode(value, "Inspect generated references", shape)
    expect(nativeValidate(value)).toBe(false)
    expect(validate(encodedInvalid)).toBe(false)
    expect(validate.errors?.length).toBeGreaterThan(0)
    expect(ToolResolver.validateToolInput("reference-fixture", binding.schema, encodedInvalid)).toBeString()
  }
  return generated
}

test("reused generated schemas preserve constraints through flat tool intent", () => {
  const shared = z.strictObject({ value: z.string() })
  const schema = z.strictObject({ first: shared, second: shared })
  const generated = verify(schema, "openai", "flat", { first: { value: "a" }, second: { value: "b" } }, [
    { first: { value: "a" }, second: { value: 3 } },
    { first: { value: "a" } },
    { first: { value: "a" }, second: { value: "b", extra: true } },
  ])
  const first = generated.properties?.first
  const second = generated.properties?.second
  expect(first && typeof first === "object" ? first.$ref : undefined).toBeString()
  expect(second && typeof second === "object" ? second.$ref : undefined).toBe(
    first && typeof first === "object" ? first.$ref : undefined,
  )
})

test("Gemini traversal and an envelope preserve nested generated references", () => {
  const leaf = z.string()
  const shared = z.strictObject({ value: leaf, label: leaf })
  const schema = z.strictObject({ workBrief: z.number(), first: shared, second: shared })
  verify(
    schema,
    "google",
    "envelope",
    { workBrief: 42, first: { value: "a", label: "a" }, second: { value: "b", label: "b" } },
    [
      { workBrief: 42, first: { value: "a", label: "a" }, second: { value: "b", label: 3 } },
      { workBrief: "wrong", first: { value: "a", label: "a" }, second: { value: "b", label: "b" } },
    ],
  )
})

test("recursive generated schemas reject invalid descendants after wrapping", () => {
  const tree = z.strictObject({
    value: z.string(),
    get children() {
      return z.array(tree)
    },
  })
  verify(tree, "openai", "envelope", { value: "root", children: [{ value: "child", children: [] }] }, [
    { value: "root", children: [{ value: 3, children: [] }] },
    { value: "root", children: [{ value: "child", children: [], extra: true }] },
  ])
})

test("nested JSON Schema resources keep their own recursive reference roots", () => {
  const tree = z.strictObject({
    value: z.string(),
    get children() {
      return z.array(tree)
    },
  })
  const resource = {
    ...z.toJSONSchema(tree, { target: "draft-2020-12", io: "input" }),
    $id: "https://schemas.example.test/reference-tree",
  }
  verifyGenerated(
    {
      type: "object",
      properties: { workBrief: { type: "number" }, tree: resource },
      required: ["workBrief", "tree"],
      additionalProperties: false,
    },
    "google",
    "envelope",
    { workBrief: 42, tree: { value: "root", children: [{ value: "child", children: [] }] } },
    [
      { workBrief: 42, tree: { value: "root", children: [{ value: 3, children: [] }] } },
      { workBrief: 42, tree: { value: "root", children: [{}] } },
    ],
  )
})

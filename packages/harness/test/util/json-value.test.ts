import { expect, test } from "bun:test"
import z from "zod"
import { resolver } from "hono-openapi"
import { JsonValue } from "../../src/util/json-value"

test("JSON evidence accepts nested values and rejects non-JSON payloads", () => {
  expect(JsonValue.parse({ nested: [null, 0, "text", { value: false }] })).toEqual({
    nested: [null, 0, "text", { value: false }],
  })
  for (const input of [undefined, { nested: [undefined] }, { value: Infinity }, new Date(), { fn() {} }]) {
    expect(JsonValue.safeParse(input).success).toBe(false)
  }
})

test("named API records containing JSON evidence do not emit dangling recursive references", async () => {
  const result = await resolver(z.object({ raw: JsonValue }).meta({ ref: "EvidenceFixture" })).toOpenAPISchema()
  expect(result.components?.schemas?.EvidenceFixture).toEqual({
    type: "object",
    properties: { raw: {} },
    required: ["raw"],
  })
})

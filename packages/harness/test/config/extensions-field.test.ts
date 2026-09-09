import { expect, test } from "bun:test"
import { z } from "zod"
import { ConfigExtensions } from "../../src/config/extensions"

test("an early config field projection retains owner metadata after registration", () => {
  const field = ConfigExtensions.field("fixtureDocumentedField")
  expect(field.safeParse(undefined).success).toBe(true)
  expect(field.safeParse(true).success).toBe(false)
  ConfigExtensions.register("fixture-documented-field", {
    shape: { fixtureDocumentedField: z.boolean().optional().describe("Owner supplied behavior contract") },
  })
  expect(field.safeParse(true).success).toBe(true)
  expect(field.safeParse(undefined).success).toBe(true)
  expect(z.toJSONSchema(field)).toMatchObject({ type: "boolean", description: "Owner supplied behavior contract" })
})

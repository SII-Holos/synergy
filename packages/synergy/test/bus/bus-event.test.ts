import { describe, expect, test } from "bun:test"
import z from "zod"
import { BusEvent } from "../../src/bus/bus-event"

describe("bus.BusEvent", () => {
  test("define returns a definition with type and properties", () => {
    const props = z.object({ name: z.string(), count: z.number() })
    const def = BusEvent.define("test.created", props)

    expect(def.type).toBe("test.created")
    expect(def.properties).toBe(props)
  })

  test("define registers multiple events in the registry", () => {
    const def1 = BusEvent.define("test.alpha", z.object({ id: z.string() }))
    const def2 = BusEvent.define("test.beta", z.object({ value: z.number() }))

    expect(def1.type).toBe("test.alpha")
    expect(def2.type).toBe("test.beta")
  })

  test("payloads returns a Zod discriminated union schema", () => {
    BusEvent.define("test.schema.check", z.object({ key: z.string() }))
    const schema = BusEvent.payloads()

    expect(schema).toBeDefined()
    const parsed = schema.safeParse({
      type: "test.schema.check",
      properties: { key: "hello" },
    })
    expect(parsed.success).toBe(true)
  })

  test("payloads schema validates matching event", () => {
    BusEvent.define("test.valid", z.object({ foo: z.string() }))
    const schema = BusEvent.payloads()

    const result = schema.safeParse({
      type: "test.valid",
      properties: { foo: "bar" },
    })
    expect(result.success).toBe(true)
  })

  test("payloads schema rejects wrong type", () => {
    BusEvent.define("test.typed", z.object({ x: z.number() }))
    const schema = BusEvent.payloads()

    const result = schema.safeParse({
      type: "nonexistent",
      properties: { x: 1 },
    })
    expect(result.success).toBe(false)
  })

  test("payloads schema rejects invalid properties", () => {
    BusEvent.define("test.propcheck", z.object({ count: z.number() }))
    const schema = BusEvent.payloads()

    const result = schema.safeParse({
      type: "test.propcheck",
      properties: { count: "not-a-number" },
    })
    expect(result.success).toBe(false)
  })

  test("payloads schema rejects missing type field", () => {
    BusEvent.define("test.missingtype", z.object({ val: z.boolean() }))
    const schema = BusEvent.payloads()

    const result = schema.safeParse({
      properties: { val: true },
    })
    expect(result.success).toBe(false)
  })
})

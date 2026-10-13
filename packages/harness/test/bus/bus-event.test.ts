import { afterAll, describe, expect, test } from "bun:test"
import { z } from "zod"
import { BusEvent } from "../../src/bus/bus-event"
import { testRuntime } from "../support/runtime"

const alpha = BusEvent.define("test.alpha", z.object({ id: z.string() }))
const beta = BusEvent.define("test.beta", z.object({ count: z.number() }))
const unregistered = BusEvent.define("test.unregistered", z.object({ name: z.string() }))
const runtime = await testRuntime({ register: () => BusEvent.register(alpha, beta) })
afterAll(() => runtime.close())

describe("bus.BusEvent", () => {
  test("definition preserves the schema without registering an event", () =>
    runtime.run(() => {
      const props = z.object({ name: z.string(), count: z.number() })
      const def = BusEvent.define("test.created", props)
      expect(def.type).toBe("test.created")
      expect(def.properties).toBe(props)
      expect(BusEvent.payloads().safeParse({ type: unregistered.type, properties: { name: "hidden" } }).success).toBe(
        false,
      )
      expect(BusEvent.payloads().safeParse({ type: def.type, properties: { name: "hidden", count: 1 } }).success).toBe(
        false,
      )
    }))

  test("payloads validates every explicitly registered event", () =>
    runtime.run(() => {
      const schema = BusEvent.payloads()
      expect(schema.parse({ type: alpha.type, properties: { id: "one" } })).toEqual({
        type: alpha.type,
        properties: { id: "one" },
      })
      expect(schema.parse({ type: beta.type, properties: { count: 2 } })).toEqual({
        type: beta.type,
        properties: { count: 2 },
      })
    }))

  test.each([
    { type: "nonexistent", properties: { count: 1 } },
    { type: beta.type, properties: { count: "not-a-number" } },
    { properties: { count: 1 } },
  ])("payloads rejects an invalid event %j", (value) =>
    runtime.run(() => expect(BusEvent.payloads().safeParse(value).success).toBe(false)),
  )

  test("registration is sealed once the Runtime starts", () =>
    runtime.run(() => expect(() => BusEvent.register(unregistered)).toThrow()))
})

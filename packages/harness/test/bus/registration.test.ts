import { expect, test } from "bun:test"
import { z } from "zod"
import { BusEvent } from "../../src/bus/bus-event"
import { testRuntime } from "../support/runtime"

const optional = BusEvent.define("fixture.optional", z.object({ value: z.string() }))

test("defining events does not activate them and registrations belong to a sealed Runtime", async () => {
  await using active = await testRuntime({
    register() {
      BusEvent.register(optional)
    },
  })
  await using absent = await testRuntime()
  const payload = { type: "fixture.optional", properties: { value: "retained" } }
  expect(await absent.run(() => BusEvent.payloads().safeParse(payload).success)).toBe(false)
  expect(await active.run(() => BusEvent.payloads().safeParse(payload).success)).toBe(true)
  await active.close()
  expect(await absent.run(() => BusEvent.payloads().safeParse(payload).success)).toBe(false)
  await absent.run(() => expect(() => BusEvent.register(optional)).toThrow("before opening the Runtime"))
})

test("failed composition does not leave event schemas in another Runtime", async () => {
  await expect(
    testRuntime({
      register() {
        BusEvent.register(optional)
        throw new Error("fixture startup rejected")
      },
    }),
  ).rejects.toThrow("fixture startup rejected")
  await using runtime = await testRuntime()
  await runtime.run(() =>
    expect(BusEvent.payloads().safeParse({ type: optional.type, properties: { value: "x" } }).success).toBe(false),
  )
})

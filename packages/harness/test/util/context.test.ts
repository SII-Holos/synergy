import { describe, expect, test } from "bun:test"
import { Context } from "../../src/util/context"

describe("Context", () => {
  test("update changes the current value within a provided context only", async () => {
    const context = Context.create<{ value: string }>("test.context")

    await context.provide({ value: "initial" }, async () => {
      expect(context.use()).toEqual({ value: "initial" })

      context.update({ value: "updated" })
      expect(context.use()).toEqual({ value: "updated" })
      expect(context.tryUse()).toEqual({ value: "updated" })
    })

    await context.provide({ value: "fresh" }, async () => {
      expect(context.use()).toEqual({ value: "fresh" })
    })
  })
})

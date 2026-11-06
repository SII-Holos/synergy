import { describe, expect, test } from "bun:test"
import { createAbortRequestController } from "../../../src/components/prompt-input/abort-request"

describe("prompt abort request", () => {
  test("enters stopping synchronously and deduplicates repeated aborts", async () => {
    const request = Promise.withResolvers<void>()
    const pending: boolean[] = []
    let calls = 0
    const controller = createAbortRequestController({
      request: async () => {
        calls++
        await request.promise
      },
      setPending(value) {
        pending.push(value)
      },
    })

    const first = controller.run()
    const second = controller.run()

    expect(pending).toEqual([true])
    expect(calls).toBe(1)
    expect(second).toBe(first)

    request.resolve()
    await first
    expect(pending).toEqual([true, false])
  })

  test("releases stopping feedback after a failed request", async () => {
    const pending: boolean[] = []
    const controller = createAbortRequestController({
      request: async () => {
        throw new Error("abort request failed")
      },
      setPending(value) {
        pending.push(value)
      },
    })

    await expect(controller.run()).rejects.toThrow("abort request failed")
    expect(pending).toEqual([true, false])
  })
})

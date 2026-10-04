import { expect, test } from "bun:test"
import { createReviewReadQueue } from "../../../src/components/workspace/review-read-queue"

test("review reads stay bounded and cancelled queued work never starts", async () => {
  const queue = createReviewReadQueue(2)
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  let running = 0,
    peak = 0,
    cancelledStarted = false
  const read = () =>
    queue.run(new AbortController().signal, async () => {
      running++
      peak = Math.max(peak, running)
      await release.promise
      running--
      return "ready"
    })
  const first = read(),
    second = read(),
    third = read()
  const cancelled = queue.run(controller.signal, async () => {
    cancelledStarted = true
  })
  controller.abort()
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
  expect(peak).toBe(2)
  release.resolve()
  expect(await Promise.all([first, second, third])).toEqual(["ready", "ready", "ready"])
  expect(peak).toBe(2)
  expect(cancelledStarted).toBe(false)
})

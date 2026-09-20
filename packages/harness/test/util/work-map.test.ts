import { expect, test } from "bun:test"
import { workMap } from "../../src/util/queue"

test("workMap drains started workers before rejecting and stops scheduling after failure", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const started: number[] = []
  let finished = false
  let settled = false
  const error = new Error("worker failed")
  const result = workMap(2, [0, 1, 2, 3], async (item) => {
    started.push(item)
    if (item === 0) {
      await entered.promise
      throw error
    }
    entered.resolve()
    await release.promise
    finished = true
    return item
  }).then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  try {
    await entered.promise
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
  } finally {
    release.resolve()
    await result
  }
  expect(finished).toBe(true)
  expect(started).toEqual([0, 1])
  expect(await result).toBe(error)
})

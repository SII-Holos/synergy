import { expect, test } from "bun:test"
import { RuntimeResources } from "../../src/resources/runtime"
import { testRuntime } from "../support/runtime"

test("continuous arrivals cannot postpone the sampler that wakes queued work", async () => {
  let samples = 0
  await using runtime = await testRuntime({
    resources: {
      sample: async () => {
        samples++
        return {
          sampledAt: Date.now(),
          pressure: "normal",
          quality: "complete",
          processRssBytes: 0,
          domains: [{ kind: "physical", capacityBytes: 8 * 1024 ** 3, availableBytes: 64 * 1024 ** 2 }],
        }
      },
    },
  })
  await runtime.run(async () => {
    const initial = samples
    const abort = new AbortController()
    const waiting: Promise<unknown>[] = []
    try {
      for (let index = 0; index < 12; index++) {
        waiting.push(RuntimeResources.acquire({ owner: String(index), bytes: 128 * 1024 ** 2, signal: abort.signal }))
        await Bun.sleep(100)
      }
      expect(samples).toBeGreaterThan(initial)
    } finally {
      abort.abort()
      await Promise.allSettled(waiting)
    }
    expect(RuntimeResources.status().queued).toBe(0)
  })
})

test("a synchronous probe failure blocks admission and still closes the source", async () => {
  let closed = 0
  const runtime = await testRuntime({
    resources: {
      sample: () => {
        throw new Error("probe unavailable")
      },
      close: () => {
        closed++
      },
    },
  })
  try {
    runtime.run(() =>
      expect(RuntimeResources.status()).toMatchObject({ state: "blocked", reason: "unavailable_sample" }),
    )
  } finally {
    await runtime.close()
  }
  expect(closed).toBe(1)
})

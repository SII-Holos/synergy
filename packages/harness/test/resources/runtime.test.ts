import { expect, test } from "bun:test"
import { RuntimeResources } from "../../src/resources/runtime"
import { testRuntime } from "../support/runtime"

test("allocation release waits for a sample started after the allocation", async () => {
  const MiB = 1024 ** 2
  let available = 1024 * MiB
  let held = false
  const captured = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  await using runtime = await testRuntime({
    resources: {
      sample: async () => {
        const value = available
        if (held) {
          held = false
          captured.resolve()
          await finish.promise
        }
        return {
          sampledAt: Date.now(),
          pressure: "normal",
          quality: "complete",
          processRssBytes: 0,
          domains: [{ kind: "physical", capacityBytes: 8 * 1024 ** 3, availableBytes: value }],
        }
      },
    },
  })
  await runtime.run(async () => {
    const lease = await RuntimeResources.reserve({ owner: "allocating", bytes: 600 * MiB })
    const abort = new AbortController()
    const waiting = RuntimeResources.acquire({ owner: "next", bytes: 500 * MiB, signal: abort.signal })
    try {
      held = true
      const oldSample = RuntimeResources.sample()
      await captured.promise
      available = 300 * MiB
      const release = lease.release()
      finish.resolve()
      await Promise.all([oldSample, release])
      expect(RuntimeResources.status().snapshot?.domains[0]?.availableBytes).toBe(available)
      expect(RuntimeResources.status().queued).toBe(1)
    } finally {
      finish.resolve()
      abort.abort()
      const result = await Promise.allSettled([waiting])
      if (result[0]?.status === "fulfilled") result[0].value.release()
      await lease.release()
    }
  })
})

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

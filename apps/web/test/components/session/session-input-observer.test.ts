import { expect, test } from "bun:test"
import { observeSessionInput } from "../../../src/components/session/session-input-observer"

test("disconnects stay recoverable and polling returns the authoritative state", async () => {
  const completed = Promise.withResolvers<void>()
  let reads = 0
  let unavailable = 0
  const stop = observeSessionInput({
    intervalMs: 1,
    read: async () => {
      if (++reads === 1) throw new Error("offline")
      return "accepted"
    },
    update: (state) => {
      expect(state).toBe("accepted")
      completed.resolve()
    },
    unavailable: () => {
      unavailable++
    },
  })
  try {
    await completed.promise
  } finally {
    stop()
  }
  expect(unavailable).toBe(1)
  expect(reads).toBe(2)
})

test("a disposed attempt aborts its request and ignores a late response", async () => {
  const pending = Promise.withResolvers<string>()
  let signal: AbortSignal | undefined
  let updates = 0
  const stop = observeSessionInput({
    read: async (value) => {
      signal = value
      return pending.promise
    },
    update: () => {
      updates++
    },
    unavailable: () => {
      updates++
    },
  })
  stop()
  pending.resolve("failed")
  await Bun.sleep(0)
  expect(signal?.aborted).toBe(true)
  expect(updates).toBe(0)
})

test("slow status requests never overlap", async () => {
  const pending = Promise.withResolvers<string>()
  let reads = 0
  const stop = observeSessionInput({
    intervalMs: 1,
    read: () => {
      reads++
      return pending.promise
    },
    update: () => {},
    unavailable: () => {},
  })
  await Bun.sleep(10)
  stop()
  pending.resolve("accepted")
  expect(reads).toBe(1)
})

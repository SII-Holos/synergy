import { expect, test } from "bun:test"
import { createSharedRequests } from "../../src/utils/shared-requests"

test("consumers share a request while cancellation releases only one subscription", async () => {
  const cache = createSharedRequests()
  const result = Promise.withResolvers<{ version: string }>()
  let calls = 0
  let underlying: AbortSignal | undefined
  const load = (signal: AbortSignal) => {
    calls++
    underlying = signal
    return result.promise
  }
  const first = new AbortController()
  const a = cache.request("runtime/scope/generation", load, { signal: first.signal }).catch((error) => error)
  const b = cache.request("runtime/scope/generation", load)
  first.abort(new Error("consumer left"))
  expect(underlying?.aborted).toBe(false)
  result.resolve({ version: "original" })
  expect(await a).toBeInstanceOf(Error)
  expect(await b).toEqual({ version: "original" })
  expect(calls).toBe(1)
  expect(await cache.request("runtime/scope/generation", load)).toEqual({ version: "original" })
  expect(calls).toBe(1)
})

test("the last cancellation aborts transport and an obsolete result cannot replace its successor", async () => {
  const cache = createSharedRequests()
  const obsolete = Promise.withResolvers<number>()
  const abort = new AbortController()
  let signal: AbortSignal | undefined
  const first = cache
    .request(
      "key",
      (value) => {
        signal = value
        return obsolete.promise
      },
      { signal: abort.signal },
    )
    .catch((error) => error)
  abort.abort()
  expect(signal?.aborted).toBe(true)
  expect(await cache.request("key", async () => 2)).toBe(2)
  obsolete.resolve(1)
  await first
  expect(await cache.request("key", async () => 3)).toBe(2)
})

test("expiry preserves the cached version and separate runtime or binding keys never merge", async () => {
  let now = 0
  const cache = createSharedRequests({ now: () => now })
  expect(await cache.request("runtime-a/scope/1", async () => ({ version: 1 }))).toEqual({ version: 1 })
  now = 4_999
  expect(await cache.request("runtime-a/scope/1", async () => ({ version: 2 }))).toEqual({ version: 1 })
  expect(await cache.request("runtime-b/scope/1", async () => ({ version: 3 }))).toEqual({ version: 3 })
  expect(await cache.request("runtime-a/scope/2", async () => ({ version: 4 }))).toEqual({ version: 4 })
  now = 5_001
  expect(await cache.request("runtime-a/scope/1", async () => ({ version: 2 }))).toEqual({ version: 2 })
})

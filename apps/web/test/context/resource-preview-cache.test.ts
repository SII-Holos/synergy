import { expect, test } from "bun:test"
import { createResourcePreviewCache } from "../../src/context/resource-preview-cache"

test("preview requests share a pending read while one cancelled reader cannot abort another", async () => {
  const cache = createResourcePreviewCache<string>()
  let reads = 0
  let finish!: (value: string) => void
  let shared!: AbortSignal
  const load = (signal: AbortSignal) => {
    reads++
    shared = signal
    return new Promise<string>((resolve) => (finish = resolve))
  }
  const cancel = new AbortController()
  const first = cache.read("one", load, cancel.signal)
  const second = cache.read("one", load)
  cancel.abort()
  await expect(first).rejects.toThrow()
  expect(shared.aborted).toBe(false)
  finish("preview")
  expect(await second).toBe("preview")
  expect(reads).toBe(1)
  expect(await cache.read("one", load)).toBe("preview")
  expect(reads).toBe(1)
})

test("disposing an owner invalidates cache and aborts pending previews", async () => {
  const cache = createResourcePreviewCache<string>()
  let shared!: AbortSignal
  const pending = cache.read("one", (signal) => {
    shared = signal
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    )
  })
  cache.clear()
  await expect(pending).rejects.toThrow()
  expect(shared.aborted).toBe(true)
  expect(await cache.read("one", async () => "fresh")).toBe("fresh")
})

test("owner invalidation rejects readers immediately even when a transport ignores cancellation", async () => {
  const cache = createResourcePreviewCache<string>()
  let finish!: (value: string) => void
  const result = cache.read("one", () => new Promise<string>((resolve) => (finish = resolve)))
  cache.clear()
  const outcome = await Promise.race([
    result.then(
      () => "resolved",
      () => "cancelled",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
  ])
  expect(outcome).toBe("cancelled")
  finish("stale")
  expect(await cache.read("one", async () => "fresh")).toBe("fresh")
})

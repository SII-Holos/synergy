import { expect, test } from "bun:test"
import { createHighlightCacheBudget, highlightInputAllowed } from "../../src/pierre/cache-budget"

test("file and diff caches share one capacity and evict least recently read results", () => {
  const budget = createHighlightCacheBudget({ maxBytes: 1024, maxEntryBytes: 800 })
  const files = budget.createCache<string>()
  const diffs = budget.createCache<string>()
  files.set("a", "a".repeat(180))
  diffs.set("b", "b".repeat(180))
  files.get("a")
  files.set("c", "c".repeat(180))
  expect(files.has("a")).toBe(true)
  expect(diffs.has("b")).toBe(false)
  expect(budget.stats().bytes).toBeLessThanOrEqual(1024)
  files.clear()
  diffs.clear()
  expect(budget.stats()).toEqual({ bytes: 0, entries: 0 })
})

test("oversized entries are not admitted and replacement removes the old weight", () => {
  const budget = createHighlightCacheBudget({ maxBytes: 1024, maxEntryBytes: 512 })
  const cache = budget.createCache<string>()
  cache.set("a", "a")
  cache.set("a", "x".repeat(1000))
  expect(cache.has("a")).toBe(false)
  expect(budget.stats().bytes).toBe(0)
  for (let i = 0; i < 1000; i++) cache.set(String(i), "small")
  expect(budget.stats().entries).toBe(cache.size)
  expect(budget.stats().bytes).toBeLessThanOrEqual(1024)
})

test("large input is rejected before highlighter dispatch", () => {
  expect(highlightInputAllowed("x".repeat(100000))).toBe(false)
  expect(highlightInputAllowed("x\n".repeat(3000))).toBe(false)
  expect(highlightInputAllowed("const x = 1")).toBe(true)
})

test("Pierre applies the injected budget to its expanded file results", async () => {
  const { WorkerPoolManager } = await import("@pierre/diffs/worker")
  const previousFrame = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  const frames = new Set<ReturnType<typeof setTimeout>>()
  globalThis.requestAnimationFrame = (callback) => {
    const frame = setTimeout(() => {
      frames.delete(frame)
      callback(performance.now())
    }, 0)
    frames.add(frame)
    return Number(frame)
  }
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  const budget = createHighlightCacheBudget({ maxBytes: 256 * 1024, maxEntryBytes: 128 * 1024 })
  const pool = new WorkerPoolManager(
    {
      poolSize: 0,
      workerFactory: () => {
        throw new Error("zero-worker test must not spawn a worker")
      },
      createASTCache: budget.createCache,
    },
    { theme: "github-dark" },
  )
  try {
    await pool.initialize()
    const small = { name: "small.ts", contents: "const hello = 1", cacheKey: "small" }
    const smallResult = pool.getPlainFileAST(small, 0, 1)!
    pool.inspectCaches().fileCache.set(small.cacheKey, { result: smallResult, options: pool.getFileRenderOptions() })
    expect(pool.getFileResultCache(small)).toBeDefined()
    expect(budget.stats().bytes).toBeGreaterThan(0)
    const large = { name: "large.ts", contents: "const large = 1\n".repeat(1000), cacheKey: "large" }
    const largeResult = pool.getPlainFileAST(large, 0, 1000)!
    pool.inspectCaches().fileCache.set(large.cacheKey, { result: largeResult, options: pool.getFileRenderOptions() })
    expect(pool.getFileResultCache(large)).toBeUndefined()
    expect(budget.stats().bytes).toBeLessThanOrEqual(256 * 1024)
    pool.inspectCaches().fileCache.clear()
    expect(budget.stats().bytes).toBe(0)
  } finally {
    pool.terminate()
    for (const frame of frames) clearTimeout(frame)
    globalThis.requestAnimationFrame = previousFrame
    globalThis.cancelAnimationFrame = previousCancel
  }
})

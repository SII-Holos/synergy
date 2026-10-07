import { expect, test } from "bun:test"
import { createMarkdownCache } from "../src/components/markdown-cache"

test("Markdown caches obey their byte budget and refresh recency", () => {
  const cache = createMarkdownCache(24)
  cache.set("a", { hash: "a", html: "123" })
  cache.set("b", { hash: "b", html: "456" })
  expect(cache.get("a")?.html).toBe("123")
  cache.set("c", { hash: "c", html: "789" })
  expect(cache.get("b")).toBeUndefined()
  expect(cache.bytes).toBeLessThanOrEqual(24)
  cache.set("oversized", { hash: "x", html: "x".repeat(20) })
  expect(cache.get("oversized")).toBeUndefined()
})

test("Markdown source runs participate in the shared cache byte budget", () => {
  const cache = createMarkdownCache(128)
  cache.set("run-budget", {
    hash: "version",
    html: "",
    document: {
      blocks: [{ html: "content", source: { start: 0, end: 10 } }],
      codes: {},
      reading: {
        marker: "owner",
        runs: [
          {
            source: { start: 0, end: 10 },
            spans: Array.from({ length: 10 }, (_, index) => ({ source: index * 2, offset: index, length: 1 })),
          },
        ],
      },
    },
  })
  expect(cache.get("run-budget")).toBeUndefined()
  expect(cache.bytes).toBe(0)
})

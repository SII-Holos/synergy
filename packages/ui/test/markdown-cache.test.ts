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

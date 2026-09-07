import { expect, test } from "bun:test"
import { createStringInterner } from "../../src/context/string-intern"

test("repeated distinct prompts cannot retain an unbounded sighting queue", () => {
  const cache = createStringInterner()
  for (let i = 0; i < 5000; i++) {
    const value = `${i}:` + "x".repeat(4096)
    expect(cache.intern(value)).toBe(value)
    cache.intern(value)
  }
  const stats = cache.stats()
  expect(stats.seenEntries).toBe(0)
  expect(stats.entries).toBeLessThanOrEqual(512)
  expect(stats.retainedBytes).toBeLessThanOrEqual(2.5 * 1024 * 1024)
})

test("oversized values bypass retention and mixed sightings stay bounded", () => {
  const cache = createStringInterner()
  const large = "x".repeat(128 * 1024)
  expect(cache.intern(large)).toBe(large)
  expect(cache.stats().retainedBytes).toBe(0)
  for (let i = 0; i < 5000; i++) {
    cache.intern(`model-${i}`)
    cache.intern("shared-package")
  }
  expect(cache.stats().seenEntries).toBeLessThanOrEqual(1088)
  expect(cache.stats().retainedBytes).toBeLessThanOrEqual(2.5 * 1024 * 1024)
})

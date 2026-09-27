import { describe, expect, test } from "bun:test"
import { SeenStore } from "../../src/hashline/seen"
import type { SeenRange } from "../../src/hashline/seen"

// ============================================================================
// Seen-Line Tracking Tests
// ============================================================================

describe("SeenStore contract", () => {
  describe("seen range recording", () => {
    test("records and retrieves a single seen range", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 50)
      const ranges = store.getSeenRanges("/app/src/a.ts")
      expect(ranges).toHaveLength(1)
      expect(ranges[0].startLine).toBe(1)
      expect(ranges[0].endLine).toBe(50)
    })

    test("overlapping seen ranges are merged", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 50)
      store.recordSeen("/app/src/a.ts", 30, 100)

      const ranges = store.getSeenRanges("/app/src/a.ts")
      expect(ranges).toHaveLength(1)
      expect(ranges[0].startLine).toBe(1)
      expect(ranges[0].endLine).toBe(100)
    })

    test("adjacent seen ranges are merged", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 50)
      store.recordSeen("/app/src/a.ts", 51, 100)

      const ranges = store.getSeenRanges("/app/src/a.ts")
      expect(ranges).toHaveLength(1)
      expect(ranges[0].startLine).toBe(1)
      expect(ranges[0].endLine).toBe(100)
    })

    test("disjoint seen ranges are kept separate", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 50)
      store.recordSeen("/app/src/a.ts", 100, 150)

      const ranges = store.getSeenRanges("/app/src/a.ts")
      expect(ranges).toHaveLength(2)
    })

    test("seen ranges for different paths are isolated", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 50)
      store.recordSeen("/app/src/b.ts", 10, 30)

      expect(store.getSeenRanges("/app/src/a.ts")).toHaveLength(1)
      expect(store.getSeenRanges("/app/src/b.ts")).toHaveLength(1)
    })
  })

  describe("seen range validation", () => {
    test("fully-seen range passes validation", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 100)
      expect(store.isRangeSeen("/app/src/a.ts", 10, 20)).toBe(true)
    })

    test("fully-unseen range fails validation", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 50)
      expect(store.isRangeSeen("/app/src/a.ts", 100, 110)).toBe(false)
    })

    test("partially-seen range fails strict validation", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 50)
      // Range 40..60: only 40..50 was seen
      expect(store.isRangeSeen("/app/src/a.ts", 40, 60)).toBe(false)
    })

    test("seen validation for a path with no recorded ranges returns false", () => {
      const store = new SeenStore()
      expect(store.isRangeSeen("/app/src/a.ts", 1, 10)).toBe(false)
    })
  })

  describe("seen data lifecycle", () => {
    test("clear removes all seen data", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 50)
      store.clear()
      expect(store.getSeenRanges("/app/src/a.ts")).toHaveLength(0)
    })

    test("seen data persists across multiple calls on same store", () => {
      const store = new SeenStore()
      store.recordSeen("/app/src/a.ts", 1, 50)
      // Immediate query should see the same data
      const ranges1 = store.getSeenRanges("/app/src/a.ts")
      expect(ranges1).toHaveLength(1)
      // Second query should still work
      const ranges2 = store.getSeenRanges("/app/src/a.ts")
      expect(ranges2).toHaveLength(1)
    })
  })
})

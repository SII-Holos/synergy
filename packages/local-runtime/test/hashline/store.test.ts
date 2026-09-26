/**
 * Tests for InMemorySnapshotStore — the new OMP API.
 * Covers equivalent behaviors as the old SnapshotStore tests.
 */
import { describe, expect, test } from "bun:test"
import { InMemorySnapshotStore } from "../../src/hashline/snapshots"
import { computeFileHash } from "../../src/hashline/format"

describe("InMemorySnapshotStore (new API)", () => {
  describe("store and retrieval", () => {
    test("records and retrieves content by path and hash", () => {
      const store = new InMemorySnapshotStore()
      const content = "const x = 1\nexport default x\n"
      const hash = computeFileHash(content)
      store.record("/app/src/a.ts", content)

      const retrieved = store.byHash("/app/src/a.ts", hash)
      expect(retrieved?.text).toBe(content)
    })

    test("head returns latest version", () => {
      const store = new InMemorySnapshotStore()
      store.record("/app/src/a.ts", "v1\n")
      store.record("/app/src/a.ts", "v2\n")
      expect(store.head("/app/src/a.ts")?.text).toBe("v2\n")
    })

    test("returns null for unknown path+hash", () => {
      const store = new InMemorySnapshotStore()
      expect(store.byHash("/app/src/a.ts", "FFFF")).toBeNull()
    })

    test("returns null for known path but unknown hash", () => {
      const store = new InMemorySnapshotStore()
      store.record("/app/src/a.ts", "content v1\n")
      expect(store.byHash("/app/src/a.ts", "0000")).toBeNull()
    })

    test("returns null for unknown path with known hash", () => {
      const store = new InMemorySnapshotStore()
      const hash = store.record("/app/src/a.ts", "content\n")
      expect(store.byHash("/app/src/b.ts", hash)).toBeNull()
    })

    test("read fusion: re-recording same content returns the same hash", () => {
      const store = new InMemorySnapshotStore()
      const content = "v1\n"
      const hash = store.record("/app/src/a.ts", content)
      const hash2 = store.record("/app/src/a.ts", content)
      expect(hash2).toBe(hash)
    })

    test("records new hash when content changes and retains old", () => {
      const store = new InMemorySnapshotStore()
      const hash1 = store.record("/app/src/a.ts", "v1\n")
      const hash2 = store.record("/app/src/a.ts", "v2\n")
      expect(hash2).not.toBe(hash1)
      expect(store.byHash("/app/src/a.ts", hash1)?.text).toBe("v1\n")
      expect(store.byHash("/app/src/a.ts", hash2)?.text).toBe("v2\n")
    })

    test("handles multiple independent paths", () => {
      const store = new InMemorySnapshotStore()
      store.record("/app/src/a.ts", "content a\n")
      store.record("/app/src/b.ts", "content b\n")
      store.record("/app/src/c.ts", "content c\n")

      expect(store.head("/app/src/a.ts")?.text).toBe("content a\n")
      expect(store.head("/app/src/b.ts")?.text).toBe("content b\n")
      expect(store.head("/app/src/c.ts")?.text).toBe("content c\n")
    })
  })

  describe("tag format", () => {
    test("record returns a valid 4-hex uppercase hash", () => {
      const store = new InMemorySnapshotStore()
      const tag = store.record("/app/src/a.ts", "content\n")
      expect(tag).toMatch(/^[0-9A-F]{4}$/)
    })

    test("record returns lowercase-hashed same tag uppercase", () => {
      const store = new InMemorySnapshotStore()
      const tag = store.record("/app/src/a.ts", "test\n")
      // All tags from computeFileHash are uppercase
      expect(tag).toBe(tag.toUpperCase())
    })
  })

  describe("invalidate and clear", () => {
    test("invalidate drops one path", () => {
      const store = new InMemorySnapshotStore()
      const hash = store.record("/app/src/a.ts", "content a\n")
      store.record("/app/src/b.ts", "content b\n")
      store.invalidate("/app/src/a.ts")
      expect(store.byHash("/app/src/a.ts", hash)).toBeNull()
      expect(store.head("/app/src/b.ts")).not.toBeNull()
    })

    test("clear empties everything", () => {
      const store = new InMemorySnapshotStore()
      const hash = store.record("/app/src/a.ts", "content\n")
      store.clear()
      expect(store.byHash("/app/src/a.ts", hash)).toBeNull()
    })
  })
})

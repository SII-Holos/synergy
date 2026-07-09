import { describe, expect, test } from "bun:test"
import { InMemorySnapshotStore } from "../../src/hashline/snapshots"
import { computeFileHash } from "../../src/hashline/format"

const PATH = "a.ts"
const TAG_RE = /^[0-9A-F]{4}$/

// ============================================================================
// InMemorySnapshotStore
// ============================================================================
describe("InMemorySnapshotStore", () => {
  test("derives the tag from whole-file content (matches computeFileHash)", () => {
    const store = new InMemorySnapshotStore()
    const text = "L1\nL2\nL3\n"
    const tag = store.record(PATH, text)
    expect(tag).toMatch(TAG_RE)
    expect(tag).toBe(computeFileHash(text))
  })

  test("fuses repeated reads of identical content onto one tag", () => {
    const store = new InMemorySnapshotStore()
    const text = "alpha\nbeta\ngamma\n"
    const first = store.record(PATH, text)
    const second = store.record(PATH, text)
    expect(second).toBe(first)
    expect(store.head(PATH)?.hash).toBe(first)
    expect(store.byHash(PATH, first)?.text).toBe(text)
  })

  test("mints a new tag when content changes and retains the prior version", () => {
    const store = new InMemorySnapshotStore()
    const v1 = "one\ntwo\n"
    const v2 = "one\ntwo\nthree\n"
    const tag1 = store.record(PATH, v1)
    const tag2 = store.record(PATH, v2)
    expect(tag2).not.toBe(tag1)
    expect(store.head(PATH)?.hash).toBe(tag2)
    expect(store.byHash(PATH, tag1)?.text).toBe(v1)
    expect(store.byHash(PATH, tag2)?.text).toBe(v2)
  })

  test("promotes a re-observed older version back to head", () => {
    const store = new InMemorySnapshotStore()
    const v1 = "x\n"
    const v2 = "y\n"
    const tag1 = store.record(PATH, v1)
    store.record(PATH, v2)
    store.record(PATH, v1)
    expect(store.head(PATH)?.hash).toBe(tag1)
  })

  test("bounds per-path history to maxVersionsPerPath (oldest dropped)", () => {
    const store = new InMemorySnapshotStore({ maxVersionsPerPath: 2 })
    const tagA = store.record(PATH, "A\n")
    const tagB = store.record(PATH, "B\n")
    const tagC = store.record(PATH, "C\n")
    expect(store.byHash(PATH, tagA)).toBeNull()
    expect(store.byHash(PATH, tagB)).not.toBeNull()
    expect(store.byHash(PATH, tagC)).not.toBeNull()
  })

  test("bounds tracked paths to maxPaths (cold path evicted)", () => {
    const store = new InMemorySnapshotStore({ maxPaths: 1 })
    const tag1 = store.record(PATH, "x\n")
    store.record("other.ts", "y\n")
    expect(store.byHash(PATH, tag1)).toBeNull()
  })

  test("rejects cross-path lookups", () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record(PATH, "a\n")
    expect(store.byHash("other.ts", tag)).toBeNull()
  })

  test("invalidate drops one path; clear drops everything", () => {
    const store = new InMemorySnapshotStore()
    const tag1 = store.record(PATH, "a\n")
    const tag2 = store.record("b.ts", "b\n")
    store.invalidate(PATH)
    expect(store.byHash(PATH, tag1)).toBeNull()
    expect(store.byHash("b.ts", tag2)).not.toBeNull()
    store.clear()
    expect(store.byHash("b.ts", tag2)).toBeNull()
  })

  test("reports retained snapshot bytes", () => {
    const store = new InMemorySnapshotStore()
    store.record(PATH, "alpha\n")
    store.record("b.ts", "bravo\n")
    expect(store.stats()).toEqual({ paths: 2, versions: 2, totalBytes: 12 })
  })

  test("seenLines stored and retrieved correctly", () => {
    const store = new InMemorySnapshotStore()
    store.record(PATH, "L1\nL2\n", [1, 2])
    const head = store.head(PATH)!
    expect(head.seenLines).toBeDefined()
    expect(head.seenLines!.has(1)).toBe(true)
    expect(head.seenLines!.has(2)).toBe(true)
    expect(head.seenLines!.has(3)).toBe(false)
  })

  test("seenLines merged across repeated reads", () => {
    const store = new InMemorySnapshotStore()
    store.record(PATH, "L1\nL2\nL3\nL4\nL5\n", [1, 2])
    store.record(PATH, "L1\nL2\nL3\nL4\nL5\n", [4, 5])
    const head = store.head(PATH)!
    expect(head.seenLines!.has(1)).toBe(true)
    expect(head.seenLines!.has(2)).toBe(true)
    expect(head.seenLines!.has(4)).toBe(true)
    expect(head.seenLines!.has(5)).toBe(true)
    expect(head.seenLines!.has(3)).toBe(false)
  })
})

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { SnapshotStore } from "../../src/hashline/store"
import path from "path"
import fs from "fs/promises"

describe("SnapshotStore", () => {
  // SnapshotStore must be a session-scoped key-value store
  // that maps path+TAG → full file content.
  // It must survive across tool calls within a session.

  describe("store and retrieval", () => {
    test("stores and retrieves content by path and tag", () => {
      const store = new SnapshotStore()
      store.set("/app/src/a.ts", "A1B2", "const x = 1\nexport default x\n")

      const retrieved = store.get("/app/src/a.ts", "A1B2")
      expect(retrieved).toBe("const x = 1\nexport default x\n")
    })

    test("returns undefined for unknown path+tag", () => {
      const store = new SnapshotStore()
      expect(store.get("/app/src/a.ts", "FFFF")).toBeUndefined()
    })

    test("returns undefined for known path but unknown tag", () => {
      const store = new SnapshotStore()
      store.set("/app/src/a.ts", "A1B2", "content v1")
      expect(store.get("/app/src/a.ts", "0000")).toBeUndefined()
    })

    test("returns undefined for unknown path with known tag", () => {
      const store = new SnapshotStore()
      store.set("/app/src/a.ts", "A1B2", "content")
      expect(store.get("/app/src/b.ts", "A1B2")).toBeUndefined()
    })

    test("overwrites content for same path+tag", () => {
      const store = new SnapshotStore()
      store.set("/app/src/a.ts", "A1B2", "v1")
      store.set("/app/src/a.ts", "A1B2", "v2")
      expect(store.get("/app/src/a.ts", "A1B2")).toBe("v2")
    })

    test("keeps old tags when new tag is set for same path", () => {
      const store = new SnapshotStore()
      store.set("/app/src/a.ts", "A1B2", "v1")
      store.set("/app/src/a.ts", "C3D4", "v2")
      expect(store.get("/app/src/a.ts", "A1B2")).toBe("v1")
      expect(store.get("/app/src/a.ts", "C3D4")).toBe("v2")
    })

    test("handles multiple independent paths", () => {
      const store = new SnapshotStore()
      store.set("/app/src/a.ts", "A1B2", "content for a")
      store.set("/app/src/b.ts", "C3D4", "content for b")
      store.set("/app/src/c.ts", "E5F6", "content for c")

      expect(store.get("/app/src/a.ts", "A1B2")).toBe("content for a")
      expect(store.get("/app/src/b.ts", "C3D4")).toBe("content for b")
      expect(store.get("/app/src/c.ts", "E5F6")).toBe("content for c")
    })
  })

  describe("tag validation", () => {
    test("validates tag format — rejects non-4-char uppercase hex", () => {
      const store = new SnapshotStore()
      expect(() => store.set("/app/src/a.ts", "1234G", "content")).toThrow()
      expect(() => store.set("/app/src/a.ts", "12345", "content")).toThrow()
      expect(() => store.set("/app/src/a.ts", "123", "content")).toThrow()
      expect(() => store.set("/app/src/a.ts", "abcd", "content")).toThrow()
    })

    test("accepts valid 4-char uppercase hex tags", () => {
      const store = new SnapshotStore()
      expect(() => store.set("/app/src/a.ts", "A1B2", "content")).not.toThrow()
      expect(() => store.set("/app/src/a.ts", "0000", "content")).not.toThrow()
      expect(() => store.set("/app/src/a.ts", "FFFF", "content")).not.toThrow()
      expect(() => store.set("/app/src/a.ts", "9D3E", "content")).not.toThrow()
    })

    test("validates tag on retrieval too", () => {
      const store = new SnapshotStore()
      store.set("/app/src/a.ts", "A1B2", "content")
      expect(() => store.get("/app/src/a.ts", "1234G")).toThrow()
    })
  })

  describe("getContentByTag", () => {
    test("returns content for a tag regardless of path", () => {
      const store = new SnapshotStore()
      store.set("/app/src/a.ts", "A1B2", "content a")
      store.set("/app/src/b.ts", "C3D4", "content b")

      const content = store.getContentByTag("A1B2")
      expect(content).toBe("content a")
    })

    test("returns undefined when tag not found in any path", () => {
      const store = new SnapshotStore()
      expect(store.getContentByTag("FFFF")).toBeUndefined()
    })
  })

  describe("bulk operations", () => {
    test("setMultiple stores multiple entries atomically", () => {
      const store = new SnapshotStore()
      store.setMultiple([
        { path: "/app/src/a.ts", tag: "A1B2", content: "content a" },
        { path: "/app/src/b.ts", tag: "C3D4", content: "content b" },
      ])

      expect(store.get("/app/src/a.ts", "A1B2")).toBe("content a")
      expect(store.get("/app/src/b.ts", "C3D4")).toBe("content b")
    })

    test("clear empties the store", () => {
      const store = new SnapshotStore()
      store.set("/app/src/a.ts", "A1B2", "content")
      store.clear()
      expect(store.get("/app/src/a.ts", "A1B2")).toBeUndefined()
    })
  })
})

import { describe, expect, test } from "bun:test"
import { PluginLogBuffer } from "../../src/plugin-runtime/logs"
import { LogRateLimiter } from "../../src/plugin-runtime/resource-limits"

describe("PluginLogBuffer", () => {
  let buffer: PluginLogBuffer

  describe("append and list", () => {
    test("stores a log entry and retrieves it by pluginId", () => {
      buffer = new PluginLogBuffer(100)
      buffer.append("plugin-a", { timestamp: Date.now(), level: "info", message: "hello" })
      const entries = buffer.list("plugin-a")
      expect(entries).toHaveLength(1)
      expect(entries[0].level).toBe("info")
      expect(entries[0].message).toBe("hello")
    })

    test("preserves insertion order (FIFO)", () => {
      buffer = new PluginLogBuffer(100)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "first" })
      buffer.append("plugin-a", { timestamp: 2, level: "warn", message: "second" })
      buffer.append("plugin-a", { timestamp: 3, level: "error", message: "third" })
      const entries = buffer.list("plugin-a")
      expect(entries).toHaveLength(3)
      expect(entries[0].message).toBe("first")
      expect(entries[1].message).toBe("second")
      expect(entries[2].message).toBe("third")
    })

    test("returns empty array for plugin with no entries", () => {
      buffer = new PluginLogBuffer(100)
      const entries = buffer.list("nonexistent")
      expect(entries).toEqual([])
    })

    test("list returns a copy, not a live reference", () => {
      buffer = new PluginLogBuffer(100)
      buffer.append("plugin-a", { timestamp: Date.now(), level: "info", message: "one" })
      const entries = buffer.list("plugin-a")
      entries.push({ timestamp: Date.now(), level: "error", message: "injected" })
      const fresh = buffer.list("plugin-a")
      expect(fresh).toHaveLength(1)
    })
  })

  describe("max entries eviction", () => {
    test("evicts oldest entries when exceeding maxEntries per plugin", () => {
      buffer = new PluginLogBuffer(3)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "1" })
      buffer.append("plugin-a", { timestamp: 2, level: "info", message: "2" })
      buffer.append("plugin-a", { timestamp: 3, level: "info", message: "3" })
      // This should evict the oldest
      buffer.append("plugin-a", { timestamp: 4, level: "info", message: "4" })
      const entries = buffer.list("plugin-a")
      expect(entries).toHaveLength(3)
      expect(entries[0].message).toBe("2")
      expect(entries[1].message).toBe("3")
      expect(entries[2].message).toBe("4")
    })

    test("reports droppedCount correctly after eviction", () => {
      buffer = new PluginLogBuffer(2)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "1" })
      buffer.append("plugin-a", { timestamp: 2, level: "info", message: "2" })
      expect(buffer.droppedCount("plugin-a")).toBe(0)
      buffer.append("plugin-a", { timestamp: 3, level: "info", message: "3" })
      expect(buffer.droppedCount("plugin-a")).toBe(1)
      buffer.append("plugin-a", { timestamp: 4, level: "info", message: "4" })
      expect(buffer.droppedCount("plugin-a")).toBe(2)
    })

    test("returns 0 droppedCount for plugin with no entries", () => {
      buffer = new PluginLogBuffer(100)
      expect(buffer.droppedCount("nonexistent")).toBe(0)
    })
  })

  describe("clear", () => {
    test("removes all entries for a plugin", () => {
      buffer = new PluginLogBuffer(100)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "a" })
      buffer.append("plugin-a", { timestamp: 2, level: "info", message: "b" })
      buffer.clear("plugin-a")
      expect(buffer.list("plugin-a")).toEqual([])
    })

    test("resets droppedCount when clearing", () => {
      buffer = new PluginLogBuffer(1)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "a" })
      buffer.append("plugin-a", { timestamp: 2, level: "info", message: "b" })
      expect(buffer.droppedCount("plugin-a")).toBe(1)
      buffer.clear("plugin-a")
      expect(buffer.droppedCount("plugin-a")).toBe(0)
    })

    test("is idempotent — clearing an empty plugin does not throw", () => {
      buffer = new PluginLogBuffer(100)
      expect(() => buffer.clear("nonexistent")).not.toThrow()
      expect(() => buffer.clear("nonexistent")).not.toThrow()
    })
  })

  describe("multi-plugin isolation", () => {
    test("separates entries by pluginId", () => {
      buffer = new PluginLogBuffer(100)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "from-a" })
      buffer.append("plugin-b", { timestamp: 2, level: "warn", message: "from-b" })
      expect(buffer.list("plugin-a")).toHaveLength(1)
      expect(buffer.list("plugin-b")).toHaveLength(1)
      expect(buffer.list("plugin-a")[0].message).toBe("from-a")
      expect(buffer.list("plugin-b")[0].message).toBe("from-b")
    })

    test("eviction in one plugin does not affect another", () => {
      buffer = new PluginLogBuffer(1)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "a1" })
      buffer.append("plugin-b", { timestamp: 2, level: "info", message: "b1" })
      // This evicts a1 but b1 should survive
      buffer.append("plugin-a", { timestamp: 3, level: "info", message: "a2" })
      expect(buffer.list("plugin-a")).toHaveLength(1)
      expect(buffer.list("plugin-a")[0].message).toBe("a2")
      expect(buffer.list("plugin-b")).toHaveLength(1)
      expect(buffer.list("plugin-b")[0].message).toBe("b1")
    })

    test("droppedCount is isolated per plugin", () => {
      buffer = new PluginLogBuffer(1)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "a1" })
      buffer.append("plugin-a", { timestamp: 2, level: "info", message: "a2" })
      buffer.append("plugin-b", { timestamp: 3, level: "info", message: "b1" })
      expect(buffer.droppedCount("plugin-a")).toBe(1)
      expect(buffer.droppedCount("plugin-b")).toBe(0)
    })

    test("clear one plugin does not affect another", () => {
      buffer = new PluginLogBuffer(100)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "a" })
      buffer.append("plugin-b", { timestamp: 2, level: "info", message: "b" })
      buffer.clear("plugin-a")
      expect(buffer.list("plugin-a")).toEqual([])
      expect(buffer.list("plugin-b")).toHaveLength(1)
    })
  })

  describe("log rate limit integration", () => {
    test("respects LogRateLimiter when provided", () => {
      // Allow 100 bytes per minute — each entry ~48 bytes, so one fits
      const limiter = new LogRateLimiter(100)
      buffer = new PluginLogBuffer(100, limiter)
      const ok = buffer.append("plugin-a", { timestamp: 1, level: "info", message: "ok" })
      expect(ok).toBe(true)
      expect(buffer.list("plugin-a")).toHaveLength(1)
    })

    test("rejects entry when rate limiter denies", () => {
      // Allow 50 bytes — first entry fits (~48 bytes), second doesn't
      const limiter = new LogRateLimiter(50)
      buffer = new PluginLogBuffer(100, limiter)
      const ok1 = buffer.append("plugin-a", { timestamp: 1, level: "info", message: "x" })
      expect(ok1).toBe(true)
      const ok2 = buffer.append("plugin-a", { timestamp: 2, level: "info", message: "y" })
      expect(ok2).toBe(false)
      expect(buffer.list("plugin-a")).toHaveLength(1)
    })

    test("still stores entry when no limiter is provided", () => {
      buffer = new PluginLogBuffer(100)
      // Large entry should still be stored when no limiter
      buffer.append("plugin-a", {
        timestamp: Date.now(),
        level: "info",
        message: "large message with many bytes to exceed",
      })
      expect(buffer.list("plugin-a")).toHaveLength(1)
    })

    test("rate limit is shared across plugins via the same limiter instance", () => {
      // Allow 50 bytes — only one entry fits total
      const limiter = new LogRateLimiter(50)
      buffer = new PluginLogBuffer(100, limiter)
      const ok1 = buffer.append("plugin-a", { timestamp: 1, level: "info", message: "a" })
      expect(ok1).toBe(true)
      const ok2 = buffer.append("plugin-b", { timestamp: 2, level: "info", message: "b" })
      expect(ok2).toBe(false) // budget exhausted — shared limiter
    })
  })

  describe("entryCount", () => {
    test("returns total entries across all plugins", () => {
      buffer = new PluginLogBuffer(100)
      expect(buffer.entryCount()).toBe(0)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "a" })
      buffer.append("plugin-b", { timestamp: 2, level: "info", message: "b" })
      expect(buffer.entryCount()).toBe(2)
    })

    test("decrements after clear", () => {
      buffer = new PluginLogBuffer(100)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "a" })
      buffer.append("plugin-a", { timestamp: 2, level: "info", message: "b" })
      buffer.clear("plugin-a")
      expect(buffer.entryCount()).toBe(0)
    })
  })

  describe("constructor", () => {
    test("defaults maxEntries to 1000 when not provided", () => {
      buffer = new PluginLogBuffer()
      expect(buffer.entryCount()).toBe(0)
      // Push 1001 entries to trigger eviction
      for (let i = 0; i < 1001; i++) {
        buffer.append("p", { timestamp: i, level: "info", message: `msg ${i}` })
      }
      expect(buffer.list("p")).toHaveLength(1000)
      expect(buffer.droppedCount("p")).toBe(1)
    })

    test("accepts zero maxEntries (no storage)", () => {
      buffer = new PluginLogBuffer(0)
      buffer.append("plugin-a", { timestamp: 1, level: "info", message: "hello" })
      expect(buffer.list("plugin-a")).toEqual([])
      expect(buffer.droppedCount("plugin-a")).toBe(1)
    })
  })
})

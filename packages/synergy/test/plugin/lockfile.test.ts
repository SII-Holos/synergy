import { test, expect, describe } from "bun:test"
import type { PluginLockEntry, PluginLockfile } from "../../src/plugin/lockfile-schema"

// Lockfile module uses Global.Path.root which is set by test/preload.ts.
// Do NOT override SYNERGY_TEST_HOME — it breaks module caching in the full suite.
const lockfileMod = await import("../../src/plugin/lockfile")

function sampleEntry(): PluginLockEntry {
  return {
    spec: "github:example/plugin",
    version: "1.0.0",
    resolved: "/some/path/index.ts",
  }
}

describe("plugin lockfile", () => {
  test("read() returns valid lockfile shape", async () => {
    const result = await lockfileMod.read()
    expect(result.version).toBe(1)
    expect(typeof result.plugins).toBe("object")
  })

  test("write() + read() round-trip preserves exact data", async () => {
    const entry = sampleEntry()
    const original: PluginLockfile = {
      version: 1,
      plugins: { "test-plugin": entry },
    }

    await lockfileMod.write(original)
    const result = await lockfileMod.read()
    expect(result).toEqual(original)
  })

  test("addEntry() adds a new entry without mutating original", () => {
    const original: PluginLockfile = {
      version: 1,
      plugins: { existing: sampleEntry() },
    }
    const newEntry: PluginLockEntry = {
      spec: "github:example/plugin-b",
      version: "2.0.0",
      resolved: "/b/index.ts",
    }

    const updated = lockfileMod.addEntry(original, "new-plugin", newEntry)
    expect(updated.plugins["existing"]).toEqual(sampleEntry())
    expect(updated.plugins["new-plugin"]).toEqual(newEntry)
    expect(Object.keys(updated.plugins)).toEqual(["existing", "new-plugin"])
    // Original is not mutated
    expect(original.plugins["new-plugin"]).toBeUndefined()
  })

  test("removeEntry() removes an existing entry without mutating original", () => {
    const original: PluginLockfile = {
      version: 1,
      plugins: {
        keep: sampleEntry(),
        drop: { spec: "drop-me", version: "1.0.0", resolved: "/drop/index.ts" },
      },
    }

    const updated = lockfileMod.removeEntry(original, "drop")
    expect(updated.plugins["keep"]).toEqual(sampleEntry())
    expect(updated.plugins["drop"]).toBeUndefined()
    expect(Object.keys(updated.plugins)).toEqual(["keep"])
    // Original is not mutated
    expect(original.plugins["drop"]).toBeDefined()
  })

  test("computeIntegrity() returns hex hash for a real file", async () => {
    const result = await lockfileMod.computeIntegrity(import.meta.path)
    expect(result).toBeTruthy()
    expect(typeof result).toBe("string")
    expect(result!.length).toBe(64) // sha256 hex is 64 chars
  })

  test("computeIntegrity() returns null for nonexistent file", async () => {
    const result = await lockfileMod.computeIntegrity("/nonexistent/path/should-not-exist.ts")
    expect(result).toBeNull()
  })

  test("checkIntegrity() returns false when entry has no integrity field", async () => {
    const entry: PluginLockEntry = {
      spec: "github:example/plugin",
      version: "1.0.0",
      resolved: import.meta.path,
      // no integrity field
    }
    const result = await lockfileMod.checkIntegrity(entry)
    expect(result).toBe(false)
  })

  test("checkIntegrity() returns true when hash matches", async () => {
    const integrity = await lockfileMod.computeIntegrity(import.meta.path)
    const entry: PluginLockEntry = {
      spec: "github:example/plugin",
      version: "1.0.0",
      resolved: import.meta.path,
      integrity: integrity ?? "",
    }
    const result = await lockfileMod.checkIntegrity(entry)
    expect(result).toBe(true)
  })

  test("checkIntegrity() returns false when hash mismatches", async () => {
    const entry: PluginLockEntry = {
      spec: "github:example/plugin",
      version: "1.0.0",
      resolved: import.meta.path,
      integrity: "sha256-0000000000000000000000000000000000000000000000000000000000000000",
    }
    const result = await lockfileMod.checkIntegrity(entry)
    expect(result).toBe(false)
  })
})

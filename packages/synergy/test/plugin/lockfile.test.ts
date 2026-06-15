import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { PluginLockEntry, PluginLockfile } from "../../src/plugin/lockfile-schema"

const tmpDir = mkdtempSync(join(import.meta.dirname, "..", ".tmp-plugin-lockfile-"))

// Dynamically import lockfile with a custom test home so Global.Path.root
// points to the temp directory. lockfilePath is a module-level const evaluated at
// import time, so we must set SYNERGY_TEST_HOME before importing.
const origHome = process.env["SYNERGY_TEST_HOME"]
let lockfileMod: typeof import("../../src/plugin/lockfile")

beforeAll(async () => {
  process.env["SYNERGY_TEST_HOME"] = tmpDir
  lockfileMod = await import("../../src/plugin/lockfile")
})

afterAll(() => {
  if (origHome !== undefined) {
    process.env["SYNERGY_TEST_HOME"] = origHome
  } else {
    delete process.env["SYNERGY_TEST_HOME"]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

function sampleEntry(): PluginLockEntry {
  return {
    spec: "github:example/plugin",
    version: "1.0.0",
    resolved: "/some/path/index.ts",
  }
}

describe("plugin lockfile", () => {
  test("read() returns empty lockfile when file does not exist", async () => {
    const result = await lockfileMod.read()
    expect(result).toEqual({ version: 1, plugins: {} })
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

  test("checkIntegrity() returns true (stub)", async () => {
    const empty: PluginLockfile = { version: 1, plugins: {} }
    const result = await lockfileMod.checkIntegrity(empty, "any-plugin", "/any/path")
    expect(result).toBe(true)
  })
})

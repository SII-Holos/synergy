import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { PluginLockEntry, PluginLockfile } from "../../src/plugin/lockfile-schema"

const tmpDir = mkdtempSync(join(import.meta.dirname, "..", ".tmp-lockfile-"))

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

describe("lockfile", () => {
  test("read returns empty lockfile when file does not exist", async () => {
    const result = await lockfileMod.read()
    expect(result).toEqual({ version: 1, plugins: {} })
  })

  test("write + read round-trip preserves exact data", async () => {
    const entry = sampleEntry()
    const original: PluginLockfile = {
      version: 1,
      plugins: { "test-plugin": entry },
    }

    await lockfileMod.write(original)
    const result = await lockfileMod.read()
    expect(result).toEqual(original)
  })

  test("write + read round-trip with multiple plugins", async () => {
    const entryA = { spec: "github:a/a", version: "1.0.0", resolved: "/a/index.ts" }
    const entryB = {
      spec: "github:b/b",
      version: "2.0.0",
      resolved: "/b/index.ts",
      integrity: "sha256-abc",
    }
    const original: PluginLockfile = {
      version: 1,
      plugins: { pluginA: entryA, pluginB: entryB },
    }

    await lockfileMod.write(original)
    const result = await lockfileMod.read()
    expect(result).toEqual(original)
  })

  test("addEntry adds a new entry", () => {
    const existing: PluginLockfile = {
      version: 1,
      plugins: { pluginA: sampleEntry() },
    }
    const newEntry: PluginLockEntry = {
      spec: "github:example/plugin-b",
      version: "2.0.0",
      resolved: "/b/index.ts",
    }

    const updated = lockfileMod.addEntry(existing, "pluginB", newEntry)
    expect(updated.plugins["pluginA"]).toEqual(sampleEntry())
    expect(updated.plugins["pluginB"]).toEqual(newEntry)
    expect(Object.keys(updated.plugins)).toEqual(["pluginA", "pluginB"])
    // Original is not mutated
    expect(existing.plugins["pluginB"]).toBeUndefined()
  })

  test("addEntry overwrites an existing entry", () => {
    const original: PluginLockfile = {
      version: 1,
      plugins: { only: { spec: "old", version: "1.0.0", resolved: "/old/index.ts" } },
    }
    const updated = lockfileMod.addEntry(original, "only", {
      spec: "new",
      version: "2.0.0",
      resolved: "/new/index.ts",
    })
    expect(updated.plugins["only"]).toEqual({
      spec: "new",
      version: "2.0.0",
      resolved: "/new/index.ts",
    })
    expect(Object.keys(updated.plugins)).toEqual(["only"])
  })

  test("removeEntry removes an existing entry", () => {
    const original: PluginLockfile = {
      version: 1,
      plugins: {
        keep: sampleEntry(),
        remove: { spec: "remove-me", version: "1.0.0", resolved: "/rm/index.ts" },
      },
    }
    const updated = lockfileMod.removeEntry(original, "remove")
    expect(updated.plugins["keep"]).toEqual(sampleEntry())
    expect(updated.plugins["remove"]).toBeUndefined()
    expect(Object.keys(updated.plugins)).toEqual(["keep"])
  })

  test("removeEntry is a no-op when entry does not exist", () => {
    const original: PluginLockfile = {
      version: 1,
      plugins: { only: sampleEntry() },
    }
    const updated = lockfileMod.removeEntry(original, "nonexistent")
    expect(updated.plugins).toEqual({ only: sampleEntry() })
  })

  test("removeEntry on single entry returns empty plugins", () => {
    const original: PluginLockfile = {
      version: 1,
      plugins: { only: sampleEntry() },
    }
    const updated = lockfileMod.removeEntry(original, "only")
    expect(updated.plugins).toEqual({})
  })
})

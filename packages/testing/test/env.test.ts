import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createIsolatedTestEnv, isTransientCleanupError } from "../src/env"

describe("createIsolatedTestEnv", () => {
  test("keeps orchestration credentials and parent file selection out of fixture children", async () => {
    const keys = ["GH_TOKEN", "GITHUB_TOKEN", "SYNERGY_TEST_FILES"] as const
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) process.env[key] = "orchestrator-fixture"
    try {
      const isolated = await createIsolatedTestEnv()
      try {
        for (const key of keys) {
          expect(isolated.env[key]).toBeUndefined()
          expect(process.env[key]).toBe("orchestrator-fixture")
        }
      } finally {
        await isolated.dispose()
      }
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })

  test("injects SYNERGY_TEST_HOME and SYNERGY_TEST_ROOT, deletes SYNERGY_HOME, forces LC_ALL=C", async () => {
    const isolated = await createIsolatedTestEnv()
    try {
      expect(isolated.env["SYNERGY_TEST_HOME"]).toBeTruthy()
      expect(isolated.env["SYNERGY_TEST_ROOT"]).toBeTruthy()
      expect("SYNERGY_HOME" in isolated.env).toBe(false)
      expect(isolated.env["SYNERGY_HOME"]).toBeUndefined()
      // Deterministic locale so process-lock suites that shell out to `ps`
      // parse start times identically regardless of the host locale.
      expect(isolated.env["LC_ALL"]).toBe("C")
      // The two roots must be disjoint from the per-process preload root.
      expect(isolated.env["SYNERGY_TEST_HOME"]).toContain("synergy-orchestrated-")
    } finally {
      await isolated.dispose()
    }
  })

  test("dispose removes the created root", async () => {
    const isolated = await createIsolatedTestEnv()
    const root = isolated.env["SYNERGY_TEST_HOME"]!
    expect(await fs.stat(pathOf(root)).catch(() => null)).not.toBeNull()
    await isolated.dispose()
    expect(await fs.stat(pathOf(root)).catch(() => null)).toBeNull()
  })

  test("does not propagate an ambient process-death watchdog into owned fixture processes", async () => {
    const previous = process.env.BUN_FEATURE_FLAG_NO_ORPHANS
    process.env.BUN_FEATURE_FLAG_NO_ORPHANS = "1"
    try {
      const isolated = await createIsolatedTestEnv()
      try {
        expect(isolated.env.BUN_FEATURE_FLAG_NO_ORPHANS).toBeUndefined()
        expect(process.env.BUN_FEATURE_FLAG_NO_ORPHANS).toBe("1")
      } finally {
        await isolated.dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.BUN_FEATURE_FLAG_NO_ORPHANS
      else process.env.BUN_FEATURE_FLAG_NO_ORPHANS = previous
    }
  })
})

function pathOf(value: string) {
  // SYNERGY_TEST_HOME is <root>/home; the created root is its parent.
  return value.replace(/\/home$/, "")
}

describe("isTransientCleanupError", () => {
  test("accepts the Windows transient lock codes", () => {
    for (const code of ["EBUSY", "EPERM", "ENOTEMPTY"]) {
      expect(isTransientCleanupError({ code })).toBe(true)
    }
  })

  test("rejects other codes and non-error values", () => {
    expect(isTransientCleanupError({ code: "EACCES" })).toBe(false)
    expect(isTransientCleanupError({ code: "ENOENT" })).toBe(false)
    expect(isTransientCleanupError(new Error("boom"))).toBe(false)
  })
})

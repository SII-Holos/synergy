import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createIsolatedTestEnv } from "../../script/test-env"

describe("createIsolatedTestEnv", () => {
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
})

function pathOf(value: string) {
  // SYNERGY_TEST_HOME is <root>/home; the created root is its parent.
  return value.replace(/\/home$/, "")
}

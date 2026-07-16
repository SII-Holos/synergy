import { describe, expect, test } from "bun:test"

describe("Clarus panel module", () => {
  test("panel module exists and exports ClarusPanel", async () => {
    const module = await import("../clarus/panel")
    expect(module).toBeDefined()
    expect(module.ClarusPanel).toBeDefined()
    expect(typeof module.ClarusPanel).toBe("function")
  })

  test("panel module resolves without throwing at import time", async () => {
    // Dynamic import exercises the full module dependency graph.
    // If the module references missing dependencies (SDK, router, solid-js
    // primitives with broken versions, etc.), the import itself fails.
    const module = await import("../clarus/panel")
    expect(module).toBeDefined()
  })
})

import { describe, expect, test } from "bun:test"

// ============================================================================
// Acceptance Gate: hashline source line count >= 4,139
//
// This test encodes the hard acceptance criteria for the OMP port:
// after implementation, the total line count of all source files under
// packages/synergy/src/hashline/ must be >= 4,139.
//
// This gate protects against partial porting — if any module is incomplete
// or too thin, the line count will fall below target and the test fails.
// ============================================================================

const TARGET_MIN_LINES = 4139

describe("hashline acceptance gate — source line count", () => {
  test(`source line count must be >= ${TARGET_MIN_LINES}`, async () => {
    const fs = await import("fs/promises")
    const path = await import("path")
    const hashDir = path.resolve(import.meta.dir, "../../src/hashline")

    let files: string[] = []
    try {
      const entries = await fs.readdir(hashDir)
      files = entries.filter((e) => e.endsWith(".ts"))
    } catch {
      // Directory may not exist yet
    }

    if (files.length === 0) {
      // No files — the port hasn't been implemented yet (expected RED)
      // We don't fail on missing directory, we just report 0 lines
      const actualLines = 0
      expect(
        actualLines,
        `hashline source lines (${actualLines}) must be >= ${TARGET_MIN_LINES}. ` +
          `The OMP port is incomplete or individual modules are too thin.`,
      ).toBeGreaterThanOrEqual(TARGET_MIN_LINES)
      return
    }

    let totalLines = 0
    for (const file of files) {
      const content = await fs.readFile(path.join(hashDir, file), "utf-8")
      totalLines += content.split("\n").length
    }

    expect(
      totalLines,
      `hashline source lines (${totalLines}) must be >= ${TARGET_MIN_LINES}. ` +
        `The OMP port is incomplete or individual modules are too thin.`,
    ).toBeGreaterThanOrEqual(TARGET_MIN_LINES)
  })

  test("all 20 hashline source modules exist", async () => {
    const expectedModules = [
      "types.ts",
      "tokenizer.ts",
      "parser.ts",
      "format.ts",
      "prefixes.ts",
      "apply.ts",
      "block.ts",
      "input.ts",
      "patcher.ts",
      "recovery.ts",
      "snapshots.ts",
      "messages.ts",
      "mismatch.ts",
      "fs.ts",
      "normalize.ts",
      "diff-preview.ts",
      "stream.ts",
      "index.ts",
      "store-session.ts",
      "seen-session.ts",
    ]

    const fs = await import("fs/promises")
    const path = await import("path")
    const hashDir = path.resolve(import.meta.dir, "../../src/hashline")

    let entries: string[]
    try {
      entries = await fs.readdir(hashDir)
    } catch {
      entries = []
    }

    const presentModules = entries.filter((e) => e.endsWith(".ts"))

    for (const expected of expectedModules) {
      expect(presentModules, `Missing hashline module: ${expected}`).toContain(expected)
    }
  })
})

import { describe, expect, test } from "bun:test"

// ============================================================================
// hashline index exports contract test
// ============================================================================

describe("hashline index exports", () => {
  test("all expected public API value symbols are exported from index", async () => {
    const mod = await import("../../src/hashline/index")

    // Runtime exports (classes, functions, constants — not pure types)
    const valueExports = [
      "Patch",
      "PatchSection",
      "parsePatch",
      "parsePatchStreaming",
      "applyEdits",
      "resolveBlockEdits",
      "Patcher",
      "PreparedSection",
      "Recovery",
      "InMemorySnapshotStore",
      "computeFileHash",
      "InMemoryFilesystem",
      "BunFilesystem",
      "NotFoundError",
      "isNotFound",
      "formatHashlineHeader",
      "formatHashlineBlock",
      "formatNumberedLine",
      "stripHashlineDisplayPrefixes",
      "streamHashLines",
      "detectLineEnding",
      "normalizeToLF",
      "stripBom",
      "MismatchError",
      "HEADTAIL_DRIFT_WARNING",
      "buildCompactDiffPreview",
      "Executor",
      "Tokenizer",
      "splitHashlineLines",
      "parseHashlinePatch",
      "computeTag",
    ]

    for (const name of valueExports) {
      expect(name in mod, `Missing export from hashline/index: ${name}`).toBe(true)
    }
  })

  test("module count check — all source modules present", async () => {
    const fs = await import("fs/promises")
    const path = await import("path")
    const hashDir = path.resolve(import.meta.dirname!, "../../src/hashline")

    const entries = await fs.readdir(hashDir)
    const tsFiles = entries.filter((e: string) => e.endsWith(".ts"))

    expect(
      tsFiles.length,
      `Expected >= 20 .ts files in src/hashline, found ${tsFiles.length}: ${tsFiles.join(", ")}`,
    ).toBeGreaterThanOrEqual(20)
  })
})

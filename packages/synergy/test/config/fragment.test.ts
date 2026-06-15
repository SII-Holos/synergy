import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadFragments } from "../../src/config/fragment"

const tmpDir = mkdtempSync(join(import.meta.dirname, "..", ".tmp-fragment-"))

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("loadFragments", () => {
  test("returns empty array when directory does not exist", async () => {
    const nonExistent = join(tmpDir, "nonexistent")
    const result = await loadFragments(nonExistent)
    expect(result).toEqual([])
  })

  test("returns empty array when no matching fragments in directory", async () => {
    const dir = join(tmpDir, "empty-fragments")
    mkdirSync(dir, { recursive: true })
    // Create only a README — no NN-name.jsonc files
    writeFileSync(join(dir, "README.md"), "# docs")
    const result = await loadFragments(dir)
    expect(result).toEqual([])
  })

  test("loads fragments sorted by NN prefix", async () => {
    const dir = join(tmpDir, "sorted-fragments")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "03-third.jsonc"), JSON.stringify({ order: 3 }))
    writeFileSync(join(dir, "01-first.jsonc"), JSON.stringify({ order: 1 }))
    writeFileSync(join(dir, "02-second.jsonc"), JSON.stringify({ order: 2 }))

    const result = await loadFragments(dir)
    expect(result).toEqual([{ order: 1 }, { order: 2 }, { order: 3 }])
  })

  test("only loads files matching NN-name.jsonc pattern", async () => {
    const dir = join(tmpDir, "pattern-fragments")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "01-valid.jsonc"), JSON.stringify({ a: 1 }))
    writeFileSync(join(dir, "02-valid.json"), JSON.stringify({ b: 2 }))
    // These should be skipped: bad pattern
    writeFileSync(join(dir, "README.md"), "# docs")
    writeFileSync(join(dir, "01-not-jsonc.txt"), JSON.stringify({ x: 1 }))
    writeFileSync(join(dir, "1-short.jsonc"), JSON.stringify({ y: 1 }))
    writeFileSync(join(dir, "abc-not-nn.jsonc"), JSON.stringify({ z: 1 }))

    const result = await loadFragments(dir)
    expect(result).toEqual([{ a: 1 }, { b: 2 }])
  })

  test("skips hidden files", async () => {
    const dir = join(tmpDir, "hidden-fragments")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".01-hidden.jsonc"), JSON.stringify({ hidden: true }))
    writeFileSync(join(dir, "01-visible.jsonc"), JSON.stringify({ visible: true }))

    const result = await loadFragments(dir)
    // Bun's readdir returns hidden files, but FragmentName regex won't match ".01-..."
    // because the regex starts with ^\d
    expect(result).toEqual([{ visible: true }])
  })

  test("parses valid JSON content in .jsonc files correctly", async () => {
    const dir = join(tmpDir, "jsonc-content")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "01-config.jsonc"), JSON.stringify({ key: "value", nested: { inner: 42 } }, null, 2))

    const result = await loadFragments(dir)
    expect(result).toEqual([{ key: "value", nested: { inner: 42 } }])
  })

  test("skips empty fragment files", async () => {
    const dir = join(tmpDir, "empty-content")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "01-empty.jsonc"), "")
    writeFileSync(join(dir, "02-valid.jsonc"), JSON.stringify({ ok: true }))

    const result = await loadFragments(dir)
    expect(result).toEqual([{ ok: true }])
  })

  test("skips fragments that are not objects (arrays)", async () => {
    const dir = join(tmpDir, "non-object")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "01-array.jsonc"), JSON.stringify([1, 2, 3]))
    writeFileSync(join(dir, "02-valid.jsonc"), JSON.stringify({ ok: true }))

    const result = await loadFragments(dir)
    expect(result).toEqual([{ ok: true }])
  })
})

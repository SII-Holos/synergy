import { describe, expect, test } from "bun:test"
import { canRenderPatch } from "../../src/components/diff-patch-utils"

describe("diff-patch canRenderPatch", () => {
  test("accepts a single-file unified diff", () => {
    const patch = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1",
      "+const b = 2",
      " const c = 3",
    ].join("\n")
    expect(canRenderPatch(patch)).toBe(true)
  })

  test("accepts a git-style patch with index header", () => {
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "index 1234567..89abcde 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1",
      "+const b = 2",
    ].join("\n")
    expect(canRenderPatch(patch)).toBe(true)
  })

  test("accepts a brand-new file patch (empty before)", () => {
    const patch = ["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+hello", "+world"].join("\n")
    expect(canRenderPatch(patch)).toBe(true)
  })

  test("rejects empty, undefined, and null patches", () => {
    expect(canRenderPatch(undefined)).toBe(false)
    expect(canRenderPatch(null)).toBe(false)
    expect(canRenderPatch("")).toBe(false)
    expect(canRenderPatch("   ")).toBe(false)
  })

  test("rejects non-diff text", () => {
    expect(canRenderPatch("just some text\nwithout any diff markers")).toBe(false)
    expect(canRenderPatch("=== combined ===\nnot a real unified diff")).toBe(false)
  })

  test("rejects truncated previews containing the omission marker", () => {
    const patch = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1",
      "\n... [12345 characters omitted] ...\n",
    ].join("\n")
    expect(canRenderPatch(patch)).toBe(false)
  })

  test("rejects multi-file patches (pierre renders one file at a time)", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+a2",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-b",
      "+b2",
    ].join("\n")
    expect(canRenderPatch(patch)).toBe(false)
  })
})

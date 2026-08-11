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

  test("rejects the synthetic combined revise_file diff (=== section markers)", () => {
    // revise_file wraps multi-section output in createTwoFilesPatch("file", "file", ...)
    // with `=== path ===` section headers embedded in content lines. It parses
    // as a single "file" entry whose line numbers span all sections, which
    // renders as a misleading merged blob — keep it on the fallback.
    const patch = [
      "Index: file",
      "===================================================================",
      "--- file",
      "+++ file",
      "@@ -1,4 +1,4 @@",
      " === src/a.ts ===",
      "-const a = 1",
      "+const a = 2",
      " === src/b.ts ===",
      "-const b = 1",
      "+const b = 2",
    ].join("\n")
    expect(canRenderPatch(patch)).toBe(false)
  })

  test("accepts a file literally named file when it is a real single-file diff", () => {
    // The synthetic-name heuristic must not reject genuine patches whose
    // path happens to be "file" (e.g. a repository file named "file").
    const patch = ["--- file", "+++ file", "@@ -1,2 +1,2 @@", "-old line", "+new line"].join("\n")
    expect(canRenderPatch(patch)).toBe(true)
  })

  test.each([
    ["addition", ["--- a/foo.ts", "+++ b/foo.ts", "@@ -1 +1,2 @@", " existing", "+"]],
    ["deletion", ["--- a/foo.ts", "+++ b/foo.ts", "@@ -1,2 +1 @@", " existing", "-"]],
    ["context", ["--- a/foo.ts", "+++ b/foo.ts", "@@ -1,2 +1,2 @@", "-old", "+new", " "]],
  ])("rejects a trailing empty %s line that pierre cannot render", (_kind, lines) => {
    expect(canRenderPatch(lines.join("\n"))).toBe(false)
  })
})

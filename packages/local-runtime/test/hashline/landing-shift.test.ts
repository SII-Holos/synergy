import { describe, expect, test } from "bun:test"
import { applyEdits, type BlockResolver, type BlockSpan, Patch, parsePatch } from "../../src/hashline/index"

const PATH = "f.ts"

const stubResolver: BlockResolver = ({ line }: { line: number }) => ({ start: line, end: line + 1 })

// ============================================================================
// after-insert landing shift
// ============================================================================
describe("after-insert landing shift", () => {
  test("slides a shallower body past the closing line and warns", () => {
    const text = [
      "function f() {", // 1
      "    if (x) {", // 2
      "        a();", // 3
      "    }", // 4
      "    b();", // 5
      "}", // 6
      "",
    ].join("\n")
    const { edits } = parsePatch("INS.POST 3:\n+    c();")
    const result = applyEdits(text, edits)
    // Body "    c();" (4-spaces, shallower than 8-space anchor on line 3)
    // Should slide past the `}` on line 4
    expect(result.warnings?.some((w) => /INS\.POST 3/i.test(w))).toBe(true)
    expect(result.text).toContain("    c();")
  })

  test("crosses multiple closer levels and stops when depth returns to the body's", () => {
    const text = [
      "function f() {", // 1
      "    for (let x of xs) {", // 2
      "        if (y) {", // 3
      "            a();", // 4
      "        }", // 5
      "    }", // 6
      "}", // 7
      "",
    ].join("\n")
    const { edits } = parsePatch("INS.POST 4:\n+    newLine();")
    const result = applyEdits(text, edits)
    expect(result.warnings?.some((w) => /INS\.POST 4/i.test(w))).toBe(true)
  })

  test("does not shift when the body matches the anchor's depth", () => {
    const text = [
      "function f() {", // 1
      "    if (x) {", // 2
      "        a();", // 3
      "    }", // 4
      "}", // 5
      "",
    ].join("\n")
    const { edits } = parsePatch("INS.POST 3:\n+        sameDepth();")
    const result = applyEdits(text, edits)
    const hasShiftWarning = result.warnings?.some((w) => /INS\.POST 3/.test(w))
    expect(hasShiftWarning ?? false).toBe(false)
  })

  test("never crosses content lines (indentation-only languages stay put)", () => {
    const text = "def foo():\n    a()\n    b()\n"
    const { edits } = parsePatch("INS.POST 2:\n+  extra()")
    const result = applyEdits(text, edits)
    const hasShiftWarning = result.warnings?.some((w) => /INS\.POST 2/.test(w))
    expect(hasShiftWarning ?? false).toBe(false)
  })

  test("treats a body of pure closers as depth-neutral", () => {
    const text = "function f() {\n    if (x) {\n        a();\n    }\n}\n"
    const { edits } = parsePatch("INS.POST 3:\n+    }")
    const result = applyEdits(text, edits)
    const hasShiftWarning = result.warnings?.some((w) => /INS\.POST 3/.test(w))
    expect(hasShiftWarning ?? false).toBe(false)
  })

  test("leaves `INS.PRE N:` untouched", () => {
    const text = "function f() {\n    if (x) {\n        a();\n    }\n}\n"
    const { edits } = parsePatch("INS.PRE 3:\n+    before()")
    const result = applyEdits(text, edits)
    const hasShiftWarning = result.warnings?.some((w) => /INS\.(PRE|POST)/.test(w))
    expect(hasShiftWarning ?? false).toBe(false)
  })
})

// ============================================================================
// insert-after-block inward landing shift
// ============================================================================
describe("insert-after-block inward landing shift", () => {
  const BLOCK_FILE = ["function f() {", "    afterEach(() => {", "        destroy();", "    });", "}", ""].join("\n")

  test("pulls a deeper body inside the block when anchor is a closer", () => {
    // INS.BLK.POST 3 with stubResolver produces span [3,4].
    // The block end (line 4) is `    });` which IS a structural closer.
    // Body `        setup();` is 8-space, deeper than 4-space closer → inward shift fires.
    const section = Patch.parseSingle(`[${PATH}#FFFF]\nINS.BLK.POST 3:\n+        setup();`)
    const result = section.applyTo(BLOCK_FILE, stubResolver)
    expect(result.warnings?.some((w) => /INS.BLK.POST/i.test(w))).toBe(true)
  })

  test("lands right after the opener of an empty block", () => {
    const emptyBlock = "function f() {\n    afterEach(() => {\n    });\n}\n"
    const section = Patch.parseSingle(`[${PATH}#FFFF]\nINS.BLK.POST 2:\n+        setup();`)
    const result = section.applyTo(emptyBlock, stubResolver)
    // Body lands inside the block (stub span [2,3])
    expect(result.text).toContain("setup()")
  })

  test("leaves a sibling-depth body after the block (the literal contract)", () => {
    const section = Patch.parseSingle(`[${PATH}#FFFF]\nINS.BLK.POST 2:\n+    sibling();`)
    const result = section.applyTo(BLOCK_FILE, stubResolver)
    const hasShiftWarning = result.warnings?.some((w) => /INS.BLK.POST/.test(w))
    expect(hasShiftWarning ?? false).toBe(false)
  })

  test("never shifts a plain `insert after M:` anchored on a closer", () => {
    const closerFile = "function f() {\n    a()\n}\n"
    const { edits } = parsePatch("INS.POST 3:\n+    extra()")
    const result = applyEdits(closerFile, edits)
    const hasShiftWarning = result.warnings?.some((w) => /INS\.POST/.test(w))
    expect(hasShiftWarning ?? false).toBe(false)
  })
})

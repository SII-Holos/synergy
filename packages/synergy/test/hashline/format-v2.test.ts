import { describe, expect, test } from "bun:test"
import {
  formatHashlineHeader,
  formatHashlineBlock,
  formatNumberedLine,
  formatNumberedLines,
  computeFileHash,
} from "../../src/hashline/index"

// ============================================================================
// formatHashlineHeader
// ============================================================================
describe("formatHashlineHeader", () => {
  test("formats a basic header with path and tag", () => {
    expect(formatHashlineHeader("src/a.ts", "1A2B")).toBe("[src/a.ts#1A2B]")
  })

  test("includes tag even when path has spaces", () => {
    expect(formatHashlineHeader("dir with spaces/file.ts", "1A2B")).toBe("[dir with spaces/file.ts#1A2B]")
  })
})

// ============================================================================
// formatHashlineBlock
// ============================================================================
describe("formatHashlineBlock", () => {
  test("formats full file display with numbered lines", () => {
    const result = formatHashlineBlock("a.ts", "1A2B", "hello\nworld\n")
    expect(result).toContain("[a.ts#1A2B]")
    expect(result).toContain("1:hello")
    expect(result).toContain("2:world")
  })

  test("handles empty content", () => {
    const result = formatHashlineBlock("empty.txt", "FFFF", "")
    expect(result).toContain("[empty.txt#FFFF]")
    // Empty content still numbers the single empty line as "1:"
    expect(result).toContain("1:")
  })
})

// ============================================================================
// formatNumberedLine
// ============================================================================
describe("formatNumberedLine", () => {
  test("formats a single line", () => {
    expect(formatNumberedLine(1, "hello")).toBe("1:hello")
  })

  test("formats with large line numbers", () => {
    expect(formatNumberedLine(1234, "content")).toBe("1234:content")
  })
})

// ============================================================================
// formatNumberedLines
// ============================================================================
describe("formatNumberedLines", () => {
  test("formats multiple lines with 1-based numbering", () => {
    expect(formatNumberedLines("a\nb\nc")).toBe("1:a\n2:b\n3:c")
  })

  test("respects startLine", () => {
    expect(formatNumberedLines("a\nb", 5)).toBe("5:a\n6:b")
  })
})

// ============================================================================
// formatV2 — basic replace/delete/insert parsing
// ============================================================================
describe("hashline format v4 — parsePatch", () => {
  test("replaces a concrete range with literal body rows", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const text = "a\nb\nc"
    const diff = ["SWAP 2.=2:", "+before", "+after"].join("\n")
    const { edits } = parsePatch(diff)
    expect(applyEdits(text, edits).text).toBe("a\nbefore\nafter\nc")
  })

  test("deletes a single source line", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const text = "a\nb\nc"
    const { edits } = parsePatch("DEL 2")
    expect(applyEdits(text, edits).text).toBe("a\nc")
  })

  test("deletes a concrete range", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const text = "a\nb\nc\nd"
    const { edits } = parsePatch("DEL 2.=3")
    expect(applyEdits(text, edits).text).toBe("a\nd")
  })

  test("inserts before and after concrete anchors", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const text = "a\nb\nc"
    const diff = ["INS.PRE 2:", "+before", "INS.POST 2:", "+after"].join("\n")
    const { edits } = parsePatch(diff)
    expect(applyEdits(text, edits).text).toBe("a\nbefore\nb\nafter\nc")
  })

  test("inserts at head and tail", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const text = "a\nb"
    expect(applyEdits(text, parsePatch("INS.HEAD:\n+HEAD").edits).text).toBe("HEAD\na\nb")
    expect(applyEdits(text, parsePatch("INS.TAIL:\n+TAIL").edits).text).toBe("a\nb\nTAIL")
  })

  test("treats an empty replace hunk as a delete", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const text = "a\nb\nc"
    expect(applyEdits(text, parsePatch("SWAP 2.=2:").edits).text).toBe("a\nc")
  })

  test("rejects body rows under delete", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    expect(() => parsePatch("DEL 2\n+replacement")).toThrow(/does not take body rows/)
  })

  test("auto-pipes bare body rows as literal text", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const text = "a\nb\nc"
    const { edits, warnings } = parsePatch("SWAP 2.=2:\nraw")
    expect(applyEdits(text, edits).text).toBe("a\nraw\nc")
    expect(warnings.some((w: string) => /Auto-prefixed bare body row/.test(w))).toBe(true)
  })

  test("strips read-output line number prefix from auto-piped bare body rows", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const text = "a\nb\nc"
    const { edits, warnings } = parsePatch("SWAP 2.=2:\n3:replaced")
    expect(applyEdits(text, edits).text).toBe("a\nreplaced\nc")
    expect(warnings.some((w: string) => /Auto-prefixed bare body row/.test(w))).toBe(true)
  })

  test("validates insert anchors against file bounds", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const { edits } = parsePatch("INS.PRE 4:\n+x")
    expect(() => applyEdits("a\nb", edits)).toThrow(/Line 4 does not exist/)
  })

  test("ignores deleting the trailing blank sentinel of a newline-terminated file", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const { edits } = parsePatch("DEL 3")
    // "a\nb\n" splits as ["a", "b", ""] — line 3 is the phantom blank
    expect(applyEdits("a\nb\n", edits).text).toBe("a\nb\n")
  })

  test("treats a delete range ending at the trailing sentinel as ending at the last real line", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const { edits } = parsePatch("DEL 2.=3")
    expect(applyEdits("a\nb\n", edits).text).toBe("a\n")
  })

  test("treats a replace range ending at the trailing sentinel as ending at the last real line", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const { edits } = parsePatch("SWAP 2.=3:\n+B")
    expect(applyEdits("a\nb\n", edits).text).toBe("a\nB\n")
  })

  test("still allows inserts anchored on the trailing blank sentinel", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const { edits } = parsePatch("INS.POST 3:\n+tail")
    expect(applyEdits("a\nb\n", edits).text).toBe("a\nb\n\ntail")
  })

  test("still deletes a genuine empty last line of a non-newline-terminated file", () => {
    const { parsePatch } = require("../../src/hashline/parser")
    const { applyEdits } = require("../../src/hashline/apply")
    const { edits } = parsePatch("DEL 2")
    expect(applyEdits("a\nb", edits).text).toBe("a")
  })
})

// ============================================================================
// parsePatchStreaming
// ============================================================================
describe("hashline streaming parser", () => {
  test("does not flush a trailing streaming pending empty replace hunk", () => {
    const { parsePatchStreaming } = require("../../src/hashline/parser")
    const result = parsePatchStreaming("SWAP 5.=5:\n")
    expect(result.edits).toEqual([])
  })

  test("flushes a streaming empty replace hunk when another hunk starts", () => {
    const { parsePatchStreaming } = require("../../src/hashline/parser")
    const result = parsePatchStreaming("SWAP 2.=2:\nINS.TAIL:\n")
    expect(result.edits.length).toBe(1)
    expect(result.edits[0].kind).toBe("delete")
  })

  test("parsePatchStreaming produces same edits as parsePatch for complete input", () => {
    const { parsePatch, parsePatchStreaming } = require("../../src/hashline/parser")
    const diff = "SWAP 2.=2:\n+X\nDEL 4\n"
    const batch = parsePatch(diff)
    const stream = parsePatchStreaming(diff)
    expect(stream.edits.length).toBe(batch.edits.length)
  })
})

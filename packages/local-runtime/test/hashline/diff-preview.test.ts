import { describe, expect, test } from "bun:test"
import { buildCompactDiffPreview } from "../../src/hashline/index"

// ============================================================================
// buildCompactDiffPreview
// ============================================================================
describe("buildCompactDiffPreview", () => {
  test("renders current lines and omits removed content while preserving counts", () => {
    const preview = buildCompactDiffPreview([" 1|alpha", "-2|beta", "+2|DELTA", "+3|EPSILON", " 3|gamma"].join("\n"))
    expect(preview.preview).toBe(["1:alpha", "2:DELTA", "3:EPSILON", "4:gamma"].join("\n"))
    expect(preview.addedLines).toBe(2)
    expect(preview.removedLines).toBe(1)
  })

  test("renumbers context lines against the post-edit file after range expansion", () => {
    const diff = [" 1|a1", " 2|a2", "-3|a3", "-4|a4", "+3|X", "+4|Y", "+5|Z", " 5|a5", " 6|a6", " 7|a7"].join("\n")
    const preview = buildCompactDiffPreview(diff)
    expect(preview.preview.split("\n")).toEqual(["1:a1", "2:a2", "3:X", "4:Y", "5:Z", "6:a5", "7:a6", "8:a7"])
  })

  test("collapses long contiguous added runs to head, marker, and tail", () => {
    const diff = Array.from({ length: 7 }, (_, i) => `+${10 + i}|line ${i + 1}`).join("\n")
    const preview = buildCompactDiffPreview(diff)
    expect(preview.preview).toBe(["10:line 1", "11:line 2", "…", "15:line 6", "16:line 7"].join("\n"))
    expect(preview.addedLines).toBe(7)
    expect(preview.removedLines).toBe(0)
  })

  test("normalizes adjacent elision markers to one unicode marker", () => {
    const preview = buildCompactDiffPreview([" 1|alpha", "...", "...", "…", " 20|omega"].join("\n"))
    expect(preview.preview).toBe(["1:alpha", "…", "20:omega"].join("\n"))
  })

  test("omits removed lines from the preview but counts them as removedLines", () => {
    const diff = ["", " 1|alpha", "", "-5|beta", "", " 9|gamma", "", "-12|omitted"].join("\n")
    const preview = buildCompactDiffPreview(diff)
    expect(preview.preview).toBe(["1:alpha", "", "8:gamma"].join("\n"))
    expect(preview.removedLines).toBe(2)
  })

  test("handles empty diff input", () => {
    const preview = buildCompactDiffPreview("")
    expect(preview.preview).toBe("")
    expect(preview.addedLines).toBe(0)
    expect(preview.removedLines).toBe(0)
  })

  test("handles diff with only removed lines", () => {
    const preview = buildCompactDiffPreview("-1|a\n-2|b")
    expect(preview.preview).toBe("")
    expect(preview.removedLines).toBe(2)
  })
})

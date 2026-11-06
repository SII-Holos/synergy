import { expect, test } from "bun:test"
import {
  previewToolContent,
  TOOL_PREVIEW_BYTES,
  TOOL_PREVIEW_LINES,
} from "../../src/components/tool/content-preview-model"

test("previews bound both Unicode bytes and line count without splitting surrogate pairs", () => {
  const result = previewToolContent("😀中文".repeat(10000))
  expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(TOOL_PREVIEW_BYTES)
  expect(result.text.endsWith("\ud83d")).toBe(false)
  expect(result.truncated).toBe(true)
  const lines = previewToolContent("line\n".repeat(1000))
  expect(lines.text.split("\n").length).toBeLessThanOrEqual(TOOL_PREVIEW_LINES)
  expect(lines.truncated).toBe(true)
})

test("a requested file range is bounded before rendering and short content is unchanged", () => {
  expect(previewToolContent("a\nb\nc", { offset: 1, limit: 1 })).toEqual({ text: "b", truncated: false })
  expect(previewToolContent("const a = 1")).toEqual({ text: "const a = 1", truncated: false })
})

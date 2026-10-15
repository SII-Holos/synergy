import { expect, test } from "bun:test"
import { toolPatchPreview } from "../../../src/components/tool/patch-preview-model"
import { TOOL_PREVIEW_BYTES, TOOL_PREVIEW_LINES } from "../../../src/components/tool/content-preview-model"

const patch = "--- file\n+++ file\n@@ -8,2 +8,2 @@\n context\n-old\n+new\n"

test("tool previews use recorded paths and actual old/new line numbers without patch syntax", () => {
  const preview = toolPatchPreview(patch, "src/example.ts")
  expect(preview.metadata?.name).toBe("src/example.ts")
  expect(preview.changes).toEqual({ additions: 1, deletions: 1 })
  expect(preview.rows).toMatchObject([
    { kind: "context", number: 8, text: "context" },
    { kind: "delete", number: 9, text: "old" },
    { kind: "add", number: 9, text: "new" },
  ])
  expect(preview.truncated).toBe(false)
})

test("previews bound rendered lines and Unicode bytes without losing recorded line positions", () => {
  const many = `--- a.ts\n+++ a.ts\n@@ -0,0 +1,300 @@\n${"+let a = 1\n".repeat(300)}`
  const preview = toolPatchPreview(many, "a.ts")
  expect(preview.rows.length).toBe(TOOL_PREVIEW_LINES)
  expect(preview.rows.at(-1)?.number).toBe(TOOL_PREVIEW_LINES)
  expect(preview.truncated).toBe(true)
  expect(preview.changes).toEqual({ additions: 300, deletions: 0 })
  const wide = toolPatchPreview(`--- a.ts\n+++ a.ts\n@@ -0,0 +1 @@\n+${"😀".repeat(4000)}\n`, "a.ts")
  expect(new TextEncoder().encode(wide.rows.map((row) => row.text).join("\n")).length).toBeLessThanOrEqual(
    TOOL_PREVIEW_BYTES,
  )
  expect(wide.rows[0]?.text.endsWith("\ud83d")).toBe(false)
  expect(wide.truncated).toBe(true)
  expect(wide.metadata).toBeUndefined()
})

test("omitted, malformed and synthetic multi-file diffs never invent code or line numbers", () => {
  for (const input of [
    "garbage",
    "--- file\n+++ file\n@@ -1 +1 @@\n-=== a.ts ===\n+=== b.ts ===\n",
    patch + "[200 characters omitted]",
  ]) {
    const preview = toolPatchPreview(input, "a.ts, b.ts")
    expect(preview.metadata).toBeUndefined()
    expect(preview.rows).toEqual([])
  }
})

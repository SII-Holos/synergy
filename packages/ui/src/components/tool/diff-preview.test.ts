import { describe, expect, test } from "bun:test"
import {
  TOOL_DIFF_PREVIEW_EMPTY_MESSAGE,
  classifyToolDiffLine,
  formatToolDiffPreviewSummary,
  parseToolDiffPreview,
} from "./diff-preview"

describe("tool diff preview", () => {
  test("classifies unified diff lines", () => {
    expect(classifyToolDiffLine("Index: C:\\Users\\Tel13\\test_file.txt")).toBe("header")
    expect(classifyToolDiffLine("========================================")).toBe("header")
    expect(classifyToolDiffLine("diff --git a/file.txt b/file.txt")).toBe("header")
    expect(classifyToolDiffLine("index 0000000..15aebc3")).toBe("header")
    expect(classifyToolDiffLine("new file mode 100644")).toBe("header")
    expect(classifyToolDiffLine("--- C:\\Users\\Tel13\\test_file.txt")).toBe("header")
    expect(classifyToolDiffLine("+++ C:\\Users\\Tel13\\test_file.txt")).toBe("header")
    expect(classifyToolDiffLine("@@ -1,5 +1,5 @@")).toBe("hunk")
    expect(classifyToolDiffLine("+This file has been successfully edited!")).toBe("add")
    expect(classifyToolDiffLine("+++added content that starts with pluses")).toBe("add")
    expect(classifyToolDiffLine("-We will edit this file shortly.")).toBe("delete")
    expect(classifyToolDiffLine("---deleted content that starts with dashes")).toBe("delete")
    expect(classifyToolDiffLine(" Hello, this is a test file.")).toBe("context")
    expect(classifyToolDiffLine("\\ No newline at end of file")).toBe("note")
  })

  test("parses previews without treating file headers as changed lines", () => {
    const lines = parseToolDiffPreview(
      [
        "Index: file.txt",
        "========================================",
        "--- file.txt",
        "+++ file.txt",
        "@@ -1,2 +1,2 @@",
        " unchanged",
        "-old",
        "+new",
        "\\ No newline at end of file",
      ].join("\n"),
    )

    expect(lines.map((line) => line.kind)).toEqual([
      "header",
      "header",
      "header",
      "header",
      "hunk",
      "context",
      "delete",
      "add",
      "note",
    ])
  })

  test("handles empty previews with the shared fallback label", () => {
    expect(parseToolDiffPreview(undefined)).toEqual([])
    expect(parseToolDiffPreview("")).toEqual([])
    expect(TOOL_DIFF_PREVIEW_EMPTY_MESSAGE).toBe("No text preview available.")
  })

  test("formats truncation summary text", () => {
    expect(formatToolDiffPreviewSummary({ beforeBytes: 134, afterBytes: 164 })).toBe("")
    expect(formatToolDiffPreviewSummary({ beforeBytes: 134, afterBytes: 164, truncated: true })).toBe(
      "Preview truncated",
    )
  })
})

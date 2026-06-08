import { describe, expect, test } from "bun:test"
import { applyPatchOps } from "../../src/hashline/revise"

describe("applyPatchOps", () => {
  const content = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n") + "\n"

  describe("replace operations", () => {
    test("replaces a single line (1-indexed)", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "replace" as const, startLine: 2, endLine: 2, lines: ["new line 2"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nnew line 2\nline 3\nline 4\nline 5\n")
    })

    test("replaces a range of lines", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "replace" as const, startLine: 2, endLine: 4, lines: ["NEW 2", "NEW 3", "NEW 4"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nNEW 2\nNEW 3\nNEW 4\nline 5\n")
    })

    test("replaces a range with fewer lines (shrinking)", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "replace" as const, startLine: 2, endLine: 4, lines: ["middle"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nmiddle\nline 5\n")
    })

    test("replaces a range with more lines (growing)", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "replace" as const, startLine: 2, endLine: 3, lines: ["A", "B", "C", "D"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nA\nB\nC\nD\nline 4\nline 5\n")
    })

    test("replace at start of file", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "replace" as const, startLine: 1, endLine: 1, lines: ["header"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("header\nline 2\nline 3\nline 4\nline 5\n")
    })

    test("replace at end of file", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "replace" as const, startLine: 5, endLine: 5, lines: ["footer"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nline 2\nline 3\nline 4\nfooter\n")
    })

    test("throws for out-of-bounds line numbers", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "replace" as const, startLine: 10, endLine: 12, lines: ["oob"] }],
      }
      expect(() => applyPatchOps(content, patch.ops)).toThrow()
    })
  })

  describe("delete operations", () => {
    test("deletes a single line", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "delete" as const, startLine: 3, endLine: 3 }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nline 2\nline 4\nline 5\n")
    })

    test("deletes a range of lines", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "delete" as const, startLine: 2, endLine: 4 }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nline 5\n")
    })
  })

  describe("insert operations", () => {
    test("insert before a line", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "insert" as const, position: "before" as const, lineNumber: 3, lines: ["inserted"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nline 2\ninserted\nline 3\nline 4\nline 5\n")
    })

    test("insert after a line", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "insert" as const, position: "after" as const, lineNumber: 3, lines: ["inserted"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nline 2\nline 3\ninserted\nline 4\nline 5\n")
    })

    test("insert at head of file", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "insert" as const, position: "head" as const, lines: ["first line"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("first line\nline 1\nline 2\nline 3\nline 4\nline 5\n")
    })

    test("insert at tail of file", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "insert" as const, position: "tail" as const, lines: ["last line"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nline 2\nline 3\nline 4\nline 5\nlast line\n")
    })

    test("insert multiple lines", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "insert" as const, position: "before" as const, lineNumber: 1, lines: ["import x", "import y"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("import x\nimport y\nline 1\nline 2\nline 3\nline 4\nline 5\n")
    })
  })

  describe("chained operations", () => {
    test("applies multiple ops in sequence (insert then replace)", () => {
      // Line numbers refer to the original file for the whole patch.
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [
          { type: "insert" as const, position: "head" as const, lines: ["header"] },
          { type: "replace" as const, startLine: 4, endLine: 4, lines: ["modified"] },
        ],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("header\nline 1\nline 2\nline 3\nmodified\nline 5\n")
    })

    test("applies delete then replace", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [
          { type: "delete" as const, startLine: 2, endLine: 2 },
          { type: "replace" as const, startLine: 4, endLine: 4, lines: ["REPLACED"] },
        ],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result).toBe("line 1\nline 3\nREPLACED\nline 5\n")
    })
  })

  describe("trailing newline preservation", () => {
    test("preserves trailing newline after operations", () => {
      const patch = {
        path: "test.txt",
        tag: "A1B2",
        ops: [{ type: "replace" as const, startLine: 1, endLine: 1, lines: ["new line 1"] }],
      }
      const result = applyPatchOps(content, patch.ops)
      expect(result.endsWith("\n")).toBe(true)
    })
  })
})

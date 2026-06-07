import { describe, expect, test } from "bun:test"
import { formatHashline, formatHashlineBlock, formatHashlineLine } from "../../src/hashline/format"
import { parseHashlinePatch } from "../../src/hashline/patch"
import type { PatchOp } from "../../src/hashline/patch"

describe("hashline format", () => {
  describe("formatHashline", () => {
    test("formats a hashline header for a path and tag", () => {
      const result = formatHashline("src/a.ts", "A1B2")
      expect(result).toBe("[src/a.ts#A1B2]")
    })

    test("formats with relative path", () => {
      const result = formatHashline("packages/app/src/index.ts", "F9E0")
      expect(result).toBe("[packages/app/src/index.ts#F9E0]")
    })

    test("formats with absolute path", () => {
      const result = formatHashline("/absolute/path/file.txt", "3C7B")
      expect(result).toBe("[/absolute/path/file.txt#3C7B]")
    })
  })

  describe("formatHashlineBlock", () => {
    test("formats a complete hashline block with content", () => {
      const content = "line1\nline2\nline3\n"
      const result = formatHashlineBlock("src/a.ts", "A1B2", content)
      expect(result).toContain("[src/a.ts#A1B2]")
      expect(result).toContain("1:line1")
      expect(result).toContain("2:line2")
      expect(result).toContain("3:line3")
    })

    test("includes newline after header", () => {
      const result = formatHashlineBlock("src/a.ts", "A1B2", "hello\n")
      expect(result.startsWith("[src/a.ts#A1B2]\n")).toBe(true)
    })

    test("handles empty file content", () => {
      const result = formatHashlineBlock("empty.txt", "D4E5", "")
      expect(result).toBe("[empty.txt#D4E5]\n")
    })

    test("line numbers are zero-padded to 5 digits", () => {
      const longContent = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n"
      const result = formatHashlineBlock("src/many.txt", "A1B2", longContent)
      expect(result).toContain("1:line0")
      expect(result).toContain("10:line9")
      expect(result).toContain("20:line19")
    })
  })

  describe("formatHashlineLine", () => {
    test("formats a single line with line number", () => {
      expect(formatHashlineLine(1, "hello")).toBe("1:hello")
    })

    test("zero-pads line numbers", () => {
      expect(formatHashlineLine(9, "x")).toBe("9:x")
      expect(formatHashlineLine(10, "x")).toBe("10:x")
      expect(formatHashlineLine(99999, "x")).toBe("99999:x")
    })
  })
})

describe("hashline patch parser", () => {
  describe("parseHashlinePatch", () => {
    describe("replace operations", () => {
      test("parses simple replace operation", () => {
        const input = "[src/a.ts#A1B2]\nreplace 2..2:\n+new line\n"
        const result = parseHashlinePatch(input)

        expect(result.tag).toBe("A1B2")
        expect(result.path).toBe("src/a.ts")
        expect(result.ops).toHaveLength(1)
        expect(result.ops[0].type).toBe("replace" satisfies PatchOp["type"])

        const op = result.ops[0] as Extract<PatchOp, { type: "replace" }>
        expect(op.startLine).toBe(2)
        expect(op.endLine).toBe(2)
        expect(op.lines).toEqual(["new line"])
      })

      test("parses single-line replace", () => {
        const input = "[src/a.ts#A1B2]\nreplace 5..5:\n+console.log(x)\n"
        const result = parseHashlinePatch(input)

        const op = result.ops[0] as Extract<PatchOp, { type: "replace" }>
        expect(op.type).toBe("replace")
        expect(op.startLine).toBe(5)
        expect(op.endLine).toBe(5)
        expect(op.lines).toEqual(["console.log(x)"])
      })

      test("parses replace with multiple new lines", () => {
        const input = "[src/a.ts#A1B2]\nreplace 3..5:\n+line A\n+line B\n+line C\n"
        const result = parseHashlinePatch(input)

        const op = result.ops[0] as Extract<PatchOp, { type: "replace" }>
        expect(op.startLine).toBe(3)
        expect(op.endLine).toBe(5)
        expect(op.lines).toEqual(["line A", "line B", "line C"])
      })
    })

    describe("delete operations", () => {
      test("parses delete operation", () => {
        const input = "[src/a.ts#A1B2]\ndelete 4..6:\n"
        const result = parseHashlinePatch(input)

        expect(result.ops).toHaveLength(1)
        expect(result.ops[0].type).toBe("delete" satisfies PatchOp["type"])

        const op = result.ops[0] as Extract<PatchOp, { type: "delete" }>
        expect(op.startLine).toBe(4)
        expect(op.endLine).toBe(6)
      })

      test("parses single-line delete", () => {
        const input = "[src/a.ts#A1B2]\ndelete 7..7:\n"
        const result = parseHashlinePatch(input)

        const op = result.ops[0] as Extract<PatchOp, { type: "delete" }>
        expect(op.startLine).toBe(7)
        expect(op.endLine).toBe(7)
      })
    })

    describe("insert operations", () => {
      test("parses insert before", () => {
        const input = "[src/a.ts#A1B2]\ninsert 3 before:\n+inserted line\n"
        const result = parseHashlinePatch(input)

        expect(result.ops[0].type).toBe("insert" satisfies PatchOp["type"])
        const op = result.ops[0] as PatchOp & {
          type: "insert"
          position: "before"
          lineNumber: number
          lines: string[]
        }
        expect(op.position).toBe("before")
        expect(op.lineNumber).toBe(3)
        expect(op.lines).toEqual(["inserted line"])
      })

      test("parses insert after", () => {
        const input = "[src/a.ts#A1B2]\ninsert 3 after:\n+after line\n"
        const result = parseHashlinePatch(input)

        const op = result.ops[0] as PatchOp & { type: "insert"; position: "after"; lineNumber: number; lines: string[] }
        expect(op.position).toBe("after")
        expect(op.lineNumber).toBe(3)
      })

      test("parses insert head", () => {
        const input = "[src/a.ts#A1B2]\ninsert head:\n+first line\n"
        const result = parseHashlinePatch(input)

        const op = result.ops[0] as Extract<PatchOp, { type: "insert" }>
        expect(op.position).toBe("head")
      })

      test("parses insert tail", () => {
        const input = "[src/a.ts#A1B2]\ninsert tail:\n+last line\n"
        const result = parseHashlinePatch(input)

        const op = result.ops[0] as Extract<PatchOp, { type: "insert" }>
        expect(op.position).toBe("tail")
      })
    })

    describe("multi-operation patches", () => {
      test("parses multiple operations in a single patch", () => {
        const input = "[src/a.ts#A1B2]\nreplace 2..2:\n+new line 2\ninsert 5 after:\n+extra line\ndelete 8..8:\n"
        const result = parseHashlinePatch(input)

        expect(result.ops).toHaveLength(3)
        expect(result.ops[0].type).toBe("replace")
        expect(result.ops[1].type).toBe("insert")
        expect(result.ops[2].type).toBe("delete")
      })
    })

    describe("header parsing", () => {
      test("extracts path and tag from header", () => {
        const input = "[src/a.ts#A1B2]\nreplace 1..1:\n+x\n"
        const result = parseHashlinePatch(input)

        expect(result.path).toBe("src/a.ts")
        expect(result.tag).toBe("A1B2")
      })

      test("extracts path with no leading dir", () => {
        const input = "[file.txt#F9E0]\nreplace 1..1:\n+x\n"
        const result = parseHashlinePatch(input)

        expect(result.path).toBe("file.txt")
        expect(result.tag).toBe("F9E0")
      })

      test("extracts path with nested dirs", () => {
        const input = "[packages/app/src/components/Button.tsx#3C7B]\nreplace 1..1:\n+x\n"
        const result = parseHashlinePatch(input)

        expect(result.path).toBe("packages/app/src/components/Button.tsx")
        expect(result.tag).toBe("3C7B")
      })
    })

    describe("validation", () => {
      test("rejects input without anchored header", () => {
        expect(() => parseHashlinePatch("replace 1..1:\n+new\n")).toThrow("Invalid patch header")
      })

      test("rejects input with malformed anchored header", () => {
        expect(() => parseHashlinePatch("[src/a.ts]\nreplace 1..1:\n+new\n")).toThrow("Invalid patch header")
      })

      test("rejects input with no tag in header", () => {
        expect(() => parseHashlinePatch("[src/a.ts#]\nreplace 1..1:\n+new\n")).toThrow(/tag|header|patch/)
      })

      test("rejects unknown operation type", () => {
        expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nunknown 1..1:\n+new\n")).toThrow(/operation|unknown|invalid/)
      })

      test("rejects replace with no replacement lines", () => {
        expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nreplace 1..1:\n")).toThrow()
      })

      test("rejects insert with no lines", () => {
        expect(() => parseHashlinePatch("[src/a.ts#A1B2]\ninsert 3 before:\n")).toThrow()
      })

      test("accepts empty trailing newline", () => {
        expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nreplace 1..1:\n+x\n\n")).not.toThrow()
      })
    })
  })
})

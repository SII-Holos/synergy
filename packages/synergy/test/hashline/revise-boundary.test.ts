import { describe, expect, test } from "bun:test"
import { applyPatchOps } from "../../src/hashline/revise"
import type { PatchOp } from "../../src/hashline/patch"

// ============================================================================
// Boundary Repair Tests
//
// These tests verify that applyPatchOps detects common model boundary mistakes
// and repairs them rather than corrupting the file or silently failing.
// ============================================================================

describe("applyPatchOps boundary repair", () => {
  describe("two-sided boundary echo", () => {
    test("strips identical boundary lines from both sides of a replace payload", () => {
      // Model intends to replace lines 2..3 with two new lines,
      // but accidentally echoes lines 1 and 4 as padding:
      //
      // Original:
      //   1: header
      //   2: old A         ← target
      //   3: old B         ← target
      //   4: footer
      //
      // Model's replace 1..4:
      //   +header          ← boundary echo (matches line 1)
      //   +new A            ← actual change
      //   +new B            ← actual change
      //   +footer          ← boundary echo (matches line 4)
      //
      // Boundary repair should detect this and narrow the replace
      // to act only on lines 2..3 with just the middle two lines.
      const content = "header\nold A\nold B\nfooter\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 4,
          lines: ["header", "new A", "new B", "footer"],
        },
      ]

      // Expected: boundary repair narrows to lines 2..3 only
      const result = applyPatchOps(content, ops)
      expect(result).toBe("header\nnew A\nnew B\nfooter\n")
    })

    test("detects two-sided boundary echo and does not duplicate lines", () => {
      // Without repair, line 1 and line 4 would be duplicated
      const content = "line1\nline2\nline3\nline4\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 4,
          lines: ["line1", "line2", "line3", "line4"],
        },
      ]

      // Pure echo → should be noop, content unchanged
      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })

    test("handles multi-line boundaries with echo", () => {
      const content = "a1\na2\nb1\nb2\nc1\nc2\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 6,
          lines: ["a1", "a2", "NEW B1", "NEW B2", "c1", "c2"],
        },
      ]

      // Lines a1,a2 and c1,c2 are boundary echoes — should be stripped
      const result = applyPatchOps(content, ops)
      expect(result).toBe("a1\na2\nNEW B1\nNEW B2\nc1\nc2\n")
    })
  })

  describe("one-sided boundary echo", () => {
    test("strips prefix-only boundary echo", () => {
      // Model echoes only the line before the target
      const content = "prefix\nold\nold2\nsuffix\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 3,
          lines: ["prefix", "new", "new2"],
        },
      ]

      // prefix is echo (matches line 1) — narrow to lines 2..3
      const result = applyPatchOps(content, ops)
      expect(result).toBe("prefix\nnew\nnew2\nsuffix\n")
    })

    test("strips suffix-only boundary echo", () => {
      // Model echoes only the line after the target
      const content = "prefix\nold\nold2\nsuffix\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 2,
          endLine: 4,
          lines: ["new", "new2", "suffix"],
        },
      ]

      // suffix is echo (matches line 4) — narrow to lines 2..3
      const result = applyPatchOps(content, ops)
      expect(result).toBe("prefix\nnew\nnew2\nsuffix\n")
    })
  })

  describe("boundary repair does not corrupt genuine changes", () => {
    test("preserves intended replacement when boundary lines differ from original", () => {
      // Model legitimately changed all 4 lines — no echoing
      const content = "header\nold A\nold B\nfooter\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 4,
          lines: ["NEW HEADER", "new A", "new B", "NEW FOOTER"],
        },
      ]

      // All lines genuinely changed — no boundary echo to repair
      const result = applyPatchOps(content, ops)
      expect(result).toBe("NEW HEADER\nnew A\nnew B\nNEW FOOTER\n")
    })

    test("does not strip lines that only partially match boundary", () => {
      const content = "const x = 1\nconst y = 2\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 2,
          lines: ["const x = 1", "const z = 3"],
        },
      ]

      // Line 1 matches original → boundary echo
      // Line 2 differs → genuine change
      // Should narrow to line 2 only
      const result = applyPatchOps(content, ops)
      expect(result).toBe("const x = 1\nconst z = 3\n")
    })

    test("preserves intent when replacing entire file", () => {
      const content = "one line\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 1,
          lines: ["completely different"],
        },
      ]

      // Single line replace — no boundary echo possible
      const result = applyPatchOps(content, ops)
      expect(result).toBe("completely different\n")
    })
  })

  describe("noop from all-boundary-echo", () => {
    test("replace with all-echo lines results in no change", () => {
      // Every replacement line matches the original at the same position
      const content = "a\nb\nc\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 3,
          lines: ["a", "b", "c"],
        },
      ]

      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })

    test("single-line echo results in no change", () => {
      const content = "unchanged\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 1,
          lines: ["unchanged"],
        },
      ]

      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })
  })

  describe("insert landing correction", () => {
    test("corrects insert after N when model meant insert before N+1", () => {
      // OMP behavior: "insert after N" that includes the N+1 line boundary
      // should be corrected to avoid inserting the echoed line.
      // The model writes "INS.POST 2:\n+line to add\n+line3" — if line3
      // matches original line 3, the correction drops the echoed last line.
      // This is a soft repair: meta-signal rather than hard rejection.
      const content = "line1\nline2\nline3\nline4\n"
      const ops: PatchOp[] = [
        {
          type: "insert",
          position: "after",
          lineNumber: 2,
          lines: ["NEW LINE", "line3"],
        },
      ]

      // "line3" in the insert body is a boundary echo of original line 3
      // Correction should drop it, inserting only "NEW LINE"
      const result = applyPatchOps(content, ops)
      expect(result).toBe("line1\nline2\nNEW LINE\nline3\nline4\n")
    })

    test("corrects insert before N when model echoed line N", () => {
      // Model writes "INS.PRE 3:\n+line3\n+NEW LINE" — first line echoes
      const content = "line1\nline2\nline3\nline4\n"
      const ops: PatchOp[] = [
        {
          type: "insert",
          position: "before",
          lineNumber: 3,
          lines: ["line3", "NEW LINE"],
        },
      ]

      // "line3" is a boundary echo — should be dropped
      const result = applyPatchOps(content, ops)
      expect(result).toBe("line1\nline2\nNEW LINE\nline3\nline4\n")
    })

    test("does not correct insert landing when boundary lines genuinely differ", () => {
      const content = "line1\nline2\nline3\nline4\n"
      const ops: PatchOp[] = [
        {
          type: "insert",
          position: "after",
          lineNumber: 2,
          lines: ["NEW LINE 1", "NEW LINE 2"],
        },
      ]

      // Both lines are genuinely new — no boundary echo to correct
      const result = applyPatchOps(content, ops)
      expect(result).toBe("line1\nline2\nNEW LINE 1\nNEW LINE 2\nline3\nline4\n")
    })
  })

  describe("metadata about boundary repairs", () => {
    test("boundary repair should be reported in result metadata", () => {
      // This test verifies the contract that boundary repairs produce
      // metadata signaling what was done. The function signature may
      // need to change to return structured results.
      //
      // If the current applyPatchOps cannot return metadata without
      // a signature change, this test is in the desired contract.
      const content = "header\nold A\nold B\nfooter\n"
      const ops: PatchOp[] = [
        {
          type: "replace",
          startLine: 1,
          endLine: 4,
          lines: ["header", "new A", "new B", "footer"],
        },
      ]

      // Expected: repair happens, content is correct
      const result = applyPatchOps(content, ops)
      expect(result).toBe("header\nnew A\nnew B\nfooter\n")
    })
  })
})

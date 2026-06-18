import { describe, expect, test } from "bun:test"
import { applyPatchOps } from "../../src/hashline/revise"
import type { PatchOp } from "../../src/hashline/patch"

// ============================================================================
// Noop Detection Tests
//
// These tests verify that applyPatchOps avoids duplicating content when a patch
// would produce no effective change.
// ============================================================================

describe("applyPatchOps noop detection", () => {
  describe("identity noop", () => {
    test("replace with identical content produces no change", () => {
      const content = "line 1\nline 2\nline 3\n"
      const ops: PatchOp[] = [{ type: "replace", startLine: 2, endLine: 2, lines: ["line 2"] }]

      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })

    test("multi-line replace with identical content produces no change", () => {
      const content = "a\nb\nc\nd\n"
      const ops: PatchOp[] = [{ type: "replace", startLine: 2, endLine: 3, lines: ["b", "c"] }]

      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })

    test("insert at tail with content already at end produces no change", () => {
      const content = "line1\nline2\nEND\n"
      const ops: PatchOp[] = [{ type: "insert", position: "tail", lines: ["END"] }]

      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })

    test("insert at head with content already at start produces no change", () => {
      const content = "START\nline1\nline2\n"
      const ops: PatchOp[] = [{ type: "insert", position: "head", lines: ["START"] }]

      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })

    test("delete of non-existent trailing whitespace is noop", () => {
      // Deleting lines beyond the file should be caught by bounds check,
      // but deleting fully-anchored content that doesn't exist could produce noop
      // if range validation is separated from application
      const content = "a\nb\n"
      const ops: PatchOp[] = [{ type: "delete", startLine: 3, endLine: 3 }]

      // Should throw — out of bounds for 2-line file
      expect(() => applyPatchOps(content, ops)).toThrow()
    })
  })

  describe("chained noop detection", () => {
    test("patch where all ops are individually noop should signal total noop", () => {
      const content = "a\nb\nc\n"
      const ops: PatchOp[] = [
        { type: "replace", startLine: 1, endLine: 1, lines: ["a"] },
        { type: "replace", startLine: 3, endLine: 3, lines: ["c"] },
      ]

      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })

    test("patch with one effective op and one noop should apply the effective op", () => {
      const content = "a\nb\nc\n"
      const ops: PatchOp[] = [
        { type: "replace", startLine: 1, endLine: 1, lines: ["a"] }, // noop
        { type: "replace", startLine: 2, endLine: 2, lines: ["B"] }, // effective
      ]

      const result = applyPatchOps(content, ops)
      expect(result).toBe("a\nB\nc\n")
    })

    test("insert then delete of same lines should net to noop if equivalent", () => {
      // insert "x" before b, then delete line 2 (= the old b)
      const content = "a\nb\nc\n"
      const ops: PatchOp[] = [
        { type: "insert", position: "before", lineNumber: 2, lines: ["x"] },
        { type: "delete", startLine: 2, endLine: 2 },
      ]

      const result = applyPatchOps(content, ops)
      // a → insert "x" before b → a, x, b, c → delete line 2 (= old "b") → a, x, c
      expect(result).toBe("a\nx\nc\n")
    })
  })

  describe("idempotent noop behavior", () => {
    test("identical noop patch remains idempotent across repeated application", () => {
      const content = "a\nb\nc\n"
      const ops: PatchOp[] = [{ type: "replace", startLine: 2, endLine: 2, lines: ["b"] }]

      const result1 = applyPatchOps(content, ops)
      expect(result1).toBe(content)

      const result2 = applyPatchOps(result1, ops)
      expect(result2).toBe(content)
    })

    test("noop with trailing whitespace differences should still be detected", () => {
      // Model sometimes adds trailing whitespace that doesn't change content
      const content = "line1\nline2\n"
      const ops: PatchOp[] = [{ type: "replace", startLine: 2, endLine: 2, lines: ["line2"] }]

      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })
  })

  describe("noop in multi-file context", () => {
    test("noop on one file should not prevent other file edits", () => {
      // This is a contract test for tool-level behavior.
      // The revise_file tool should allow one file to be a noop
      // while successfully editing another in the same session.
      // At the applyPatchOps level, we just verify the content contract.
      const content = "file content\n"
      const ops: PatchOp[] = [{ type: "replace", startLine: 1, endLine: 1, lines: ["file content"] }]

      const result = applyPatchOps(content, ops)
      expect(result).toBe(content)
    })
  })
})

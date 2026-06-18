import { describe, expect, test } from "bun:test"
import { recoverPatchOps } from "../../src/hashline/recovery"
import type { PatchOp } from "../../src/hashline/patch"

// ============================================================================
// Recovery: Block Swap Support Tests
//
// These tests verify that recovery can preserve blockSwap operations when the
// original snapshot block can still be found after content drift, and refuses
// recovery when that block can no longer be located.
// ============================================================================

function blockSwapOp(blockRef: string, lines: string[]): PatchOp {
  return { type: "blockSwap", blockRef, lines }
}

describe("recoverPatchOps with blockSwap", () => {
  describe("blockSwap op recovery", () => {
    test("recovers blockSwap op when snapshot block exists in live file at shifted position", () => {
      const snapshot = "import a\nimport b\nimport c\n// after imports\n"
      const live = "// preamble\nimport a\nimport b\nimport c\n// after imports\n"
      const ops: PatchOp[] = [blockSwapOp("imports", ["import x", "import y", "import z"])]

      const result = recoverPatchOps(snapshot, live, ops)
      expect(result.mode).toBe("three-way-merge")
      expect(result.ops).toHaveLength(1)
    })

    test("blockSwap recovery preserves replacement lines", () => {
      const snapshot = "line1\nline2\nline3\n"
      const live = "line1\nline2\nline3\n"
      const ops: PatchOp[] = [blockSwapOp("middle", ["X", "Y"])]

      const result = recoverPatchOps(snapshot, live, ops)
      const recovered = result.ops[0] as any
      // Recovery keeps the blockSwap operation intact for the later apply step.
      expect(recovered.type).toBe("blockSwap")
      expect(recovered.lines).toEqual(["X", "Y"])
    })

    test("blockSwap recovery refuses when block cannot be found in live content", () => {
      const snapshot = "import a\nimport b\nimport c\nrest\n"
      const live = "rest\n"
      const ops: PatchOp[] = [blockSwapOp("imports", ["x"])]

      // Should throw because the block can't be located in live content
      expect(() => recoverPatchOps(snapshot, live, ops)).toThrow()
    })
  })

  describe("mixed blockSwap and legacy ops in recovery", () => {
    test("recovers a patch with both blockSwap and replace ops", () => {
      const snapshot = "line1\nline2\nline3\nline4\n"
      const live = "header\nline1\nline2\nline3\nline4\n"
      const ops: PatchOp[] = [blockSwapOp("b", ["B"]), { type: "replace", startLine: 3, endLine: 3, lines: ["C"] }]

      const result = recoverPatchOps(snapshot, live, ops)
      expect(result.mode).toBe("three-way-merge")
      expect(result.ops).toHaveLength(2)
    })

    test("recovers blockSwap alongside insert and delete ops", () => {
      const snapshot = "a\nb\nc\nd\ne\n"
      const live = "a\nb\nc\nd\ne\n"
      const ops: PatchOp[] = [
        { type: "insert", position: "head", lines: ["pre"] },
        blockSwapOp("mid", ["M"]),
        { type: "delete", startLine: 5, endLine: 5 },
      ]

      const result = recoverPatchOps(snapshot, live, ops)
      expect(result.ops).toHaveLength(3)
    })
  })

  describe("recovery mode metadata for blockSwap", () => {
    test("recovery signals three-way-merge mode for blockSwap recovery", () => {
      const snapshot = "import a\nimport b\n"
      const live = "preamble\nimport a\nimport b\n"
      const ops: PatchOp[] = [blockSwapOp("imports", ["import x"])]

      const result = recoverPatchOps(snapshot, live, ops)
      expect(result.mode).toBe("three-way-merge")
    })
  })
})

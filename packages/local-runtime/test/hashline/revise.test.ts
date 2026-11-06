import { describe, expect, test } from "bun:test"
import { applyPatchOps } from "../../src/hashline/revise"
import type { PatchOp } from "../../src/hashline/patch"

describe("applyPatchOps", () => {
  test("applies a replace op over the given line range", () => {
    const content = "a\nb\nc\n"
    const ops: PatchOp[] = [{ type: "replace", startLine: 1, endLine: 2, lines: ["x", "y"] }]
    expect(applyPatchOps(content, ops)).toBe("x\ny\nc\n")
  })

  test("applies a delete op", () => {
    const content = "a\nb\nc\n"
    const ops: PatchOp[] = [{ type: "delete", startLine: 2, endLine: 3 }]
    expect(applyPatchOps(content, ops)).toBe("a\n")
  })

  test("applies before and after insert ops", () => {
    const content = "a\nb\nc\n"
    const ops: PatchOp[] = [
      { type: "insert", position: "before", lineNumber: 1, lines: ["x"] },
      { type: "insert", position: "after", lineNumber: 3, lines: ["y"] },
    ]
    expect(applyPatchOps(content, ops)).toBe("x\na\nb\nc\ny\n")
  })

  test("applies head and tail insert ops", () => {
    const content = "a\nb\n"
    const ops: PatchOp[] = [
      { type: "insert", position: "head", lines: ["start"] },
      { type: "insert", position: "tail", lines: ["end"] },
    ]
    expect(applyPatchOps(content, ops)).toBe("start\na\nb\nend\n")
  })

  test("rejects unresolved blockSwap ops", () => {
    const content = "if (ok) {\n  run()\n}\n"
    const ops: PatchOp[] = [{ type: "blockSwap", blockRef: "1", lines: ["if (ok) {", "  stop()", "}"] }]
    expect(() => applyPatchOps(content, ops)).toThrow(/unresolved `SWAP\.BLK`/)
  })

  test("throws for invalid blockRef", () => {
    expect(() => applyPatchOps("a\n", [{ type: "blockSwap", blockRef: "abc", lines: ["x"] }])).toThrow(
      /numeric blockRef/,
    )
  })

  test("throws for an invalid insert position", () => {
    expect(() =>
      applyPatchOps("a\n", [{ type: "insert", position: "middle" as never, lines: ["x"] } as PatchOp]),
    ).toThrow(/Invalid insert position/)
  })
})

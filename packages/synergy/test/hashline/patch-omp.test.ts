import { describe, expect, test } from "bun:test"
import { parseHashlinePatch } from "../../src/hashline/patch"
import type { PatchOp } from "../../src/hashline/patch"

// ============================================================================
// OMP Syntax Parser Tests
//
// These tests verify that the parser normalizes OMP verbs into the existing
// PatchOp types where possible, and uses BlockSwapOp for SWAP.BLK.
// ============================================================================

describe("OMP syntax parsing", () => {
  describe("SWAP — OMP replace (normalizes to replace op)", () => {
    test("SWAP N..M with body lines normalizes to replace op", () => {
      const input = "[src/a.ts#A1B2]\nSWAP 2..2:\n+new line\n"
      const result = parseHashlinePatch(input)

      expect(result.ops).toHaveLength(1)
      expect(result.ops[0].type).toBe("replace" satisfies PatchOp["type"])

      const op = result.ops[0] as Extract<PatchOp, { type: "replace" }>
      expect(op.startLine).toBe(2)
      expect(op.endLine).toBe(2)
      expect(op.lines).toEqual(["new line"])
    })

    test("SWAP multi-line range normalizes to replace op", () => {
      const input = "[src/a.ts#A1B2]\nSWAP 3..5:\n+line A\n+line B\n+line C\n"
      const result = parseHashlinePatch(input)

      expect(result.ops[0].type).toBe("replace")
      const op = result.ops[0] as Extract<PatchOp, { type: "replace" }>
      expect(op.startLine).toBe(3)
      expect(op.endLine).toBe(5)
      expect(op.lines).toEqual(["line A", "line B", "line C"])
    })

    test("SWAP N.=M (equals separator) normalizes to replace op identically to SWAP N..M", () => {
      // OMP-style: SWAP 2.=5 means "swap lines 2 through 5"
      const input = "[src/a.ts#A1B2]\nSWAP 2.=5:\n+new content\n"
      const result = parseHashlinePatch(input)

      expect(result.ops[0].type).toBe("replace")
      const op = result.ops[0] as Extract<PatchOp, { type: "replace" }>
      expect(op.startLine).toBe(2)
      expect(op.endLine).toBe(5)
      expect(op.lines).toEqual(["new content"])
    })

    test("SWAP preserves the same internal representation as legacy replace", () => {
      const swapInput = "[src/a.ts#A1B2]\nSWAP 2..4:\n+A\n+B\n"
      const replaceInput = "[src/a.ts#A1B2]\nreplace 2..4:\n+A\n+B\n"

      const swapResult = parseHashlinePatch(swapInput)
      const replaceResult = parseHashlinePatch(replaceInput)

      // Both should produce identical ops (normalized)
      expect(swapResult.ops).toHaveLength(1)
      expect(replaceResult.ops).toHaveLength(1)
      if (swapResult.ops[0].type === "replace" && replaceResult.ops[0].type === "replace") {
        expect(swapResult.ops[0].startLine).toBe(replaceResult.ops[0].startLine)
        expect(swapResult.ops[0].endLine).toBe(replaceResult.ops[0].endLine)
        expect(swapResult.ops[0].lines).toEqual(replaceResult.ops[0].lines)
      }
    })
  })

  describe("DEL — OMP delete (normalizes to delete op)", () => {
    test("DEL N..M normalizes to delete op", () => {
      const input = "[src/a.ts#A1B2]\nDEL 4..6:\n"
      const result = parseHashlinePatch(input)

      expect(result.ops).toHaveLength(1)
      expect(result.ops[0].type).toBe("delete" satisfies PatchOp["type"])

      const op = result.ops[0] as Extract<PatchOp, { type: "delete" }>
      expect(op.startLine).toBe(4)
      expect(op.endLine).toBe(6)
    })

    test("DEL N (single line) normalizes to single-line delete op", () => {
      const input = "[src/a.ts#A1B2]\nDEL 7:\n"
      const result = parseHashlinePatch(input)

      expect(result.ops[0].type).toBe("delete")
      const op = result.ops[0] as Extract<PatchOp, { type: "delete" }>
      expect(op.startLine).toBe(7)
      expect(op.endLine).toBe(7)
    })

    test("DEL without colon still parses", () => {
      // Some OMP variants omit the trailing colon for delete
      const input = "[src/a.ts#A1B2]\nDEL 3..5\n"
      const result = parseHashlinePatch(input)

      expect(result.ops[0].type).toBe("delete")
      const op = result.ops[0] as Extract<PatchOp, { type: "delete" }>
      expect(op.startLine).toBe(3)
      expect(op.endLine).toBe(5)
    })

    test("DEL preserves the same internal representation as legacy delete", () => {
      const delInput = "[src/a.ts#A1B2]\nDEL 4..6:\n"
      const deleteInput = "[src/a.ts#A1B2]\ndelete 4..6:\n"

      const delResult = parseHashlinePatch(delInput)
      const deleteResult = parseHashlinePatch(deleteInput)

      expect(delResult.ops).toHaveLength(1)
      expect(deleteResult.ops).toHaveLength(1)
      if (delResult.ops[0].type === "delete" && deleteResult.ops[0].type === "delete") {
        expect(delResult.ops[0].startLine).toBe(deleteResult.ops[0].startLine)
        expect(delResult.ops[0].endLine).toBe(deleteResult.ops[0].endLine)
      }
    })
  })

  describe("INS.PRE — OMP insert before (normalizes to insert before op)", () => {
    test("INS.PRE N normalizes to insert before op", () => {
      const input = "[src/a.ts#A1B2]\nINS.PRE 3:\n+inserted line\n"
      const result = parseHashlinePatch(input)

      expect(result.ops[0].type).toBe("insert" satisfies PatchOp["type"])
      const op = result.ops[0] as PatchOp & { type: "insert"; position: "before"; lineNumber: number; lines: string[] }
      expect(op.position).toBe("before")
      expect(op.lineNumber).toBe(3)
      expect(op.lines).toEqual(["inserted line"])
    })

    test("INS.PRE preserves same internal representation as legacy insert before", () => {
      const ompInput = "[src/a.ts#A1B2]\nINS.PRE 3:\n+inserted line\n"
      const legacyInput = "[src/a.ts#A1B2]\ninsert 3 before:\n+inserted line\n"

      const ompResult = parseHashlinePatch(ompInput)
      const legacyResult = parseHashlinePatch(legacyInput)

      expect(ompResult.ops).toHaveLength(1)
      expect(legacyResult.ops).toHaveLength(1)
      const ompOp = ompResult.ops[0]
      const legacyOp = legacyResult.ops[0]
      if (
        ompOp.type === "insert" &&
        ompOp.position === "before" &&
        legacyOp.type === "insert" &&
        legacyOp.position === "before"
      ) {
        expect(ompOp.lineNumber).toBe(legacyOp.lineNumber)
        expect(ompOp.lines).toEqual(legacyOp.lines)
      }
    })
  })

  describe("INS.POST — OMP insert after (normalizes to insert after op)", () => {
    test("INS.POST N normalizes to insert after op", () => {
      const input = "[src/a.ts#A1B2]\nINS.POST 3:\n+after line\n"
      const result = parseHashlinePatch(input)

      expect(result.ops[0].type).toBe("insert")
      const op = result.ops[0] as PatchOp & { type: "insert"; position: "after"; lineNumber: number; lines: string[] }
      expect(op.position).toBe("after")
      expect(op.lineNumber).toBe(3)
      expect(op.lines).toEqual(["after line"])
    })
  })

  describe("INS.HEAD — OMP insert head (normalizes to insert head op)", () => {
    test("INS.HEAD normalizes to insert head op", () => {
      const input = "[src/a.ts#A1B2]\nINS.HEAD:\n+first line\n"
      const result = parseHashlinePatch(input)

      expect(result.ops[0].type).toBe("insert")
      const op = result.ops[0] as Extract<PatchOp, { type: "insert" }>
      expect(op.position).toBe("head")
    })

    test("INS.HEAD with multiple lines", () => {
      const input = "[src/a.ts#A1B2]\nINS.HEAD:\n+line 1\n+line 2\n"
      const result = parseHashlinePatch(input)

      const op = result.ops[0] as Extract<PatchOp, { type: "insert" }>
      expect(op.position).toBe("head")
      expect(op.lines).toEqual(["line 1", "line 2"])
    })
  })

  describe("INS.TAIL — OMP insert tail (normalizes to insert tail op)", () => {
    test("INS.TAIL normalizes to insert tail op", () => {
      const input = "[src/a.ts#A1B2]\nINS.TAIL:\n+last line\n"
      const result = parseHashlinePatch(input)

      expect(result.ops[0].type).toBe("insert")
      const op = result.ops[0] as Extract<PatchOp, { type: "insert" }>
      expect(op.position).toBe("tail")
    })
  })

  describe("SWAP.BLK — OMP block swap (new op type)", () => {
    test("SWAP.BLK <ref> produces a blockSwap op", () => {
      const input =
        "[src/a.ts#A1B2]\nSWAP.BLK import_block:\n+import { foo } from './foo'\n+import { bar } from './bar'\n"
      const result = parseHashlinePatch(input)

      expect(result.ops).toHaveLength(1)
      // BlockSwapOp is a new internal op type distinct from replace/delete/insert
      const opType = result.ops[0].type as string
      expect(opType).toBe("blockSwap")
    })

    test("SWAP.BLK op carries the block reference name", () => {
      const input = "[src/a.ts#A1B2]\nSWAP.BLK header_section:\n+// Header comment\n+// Another\n"
      const result = parseHashlinePatch(input)

      const op = result.ops[0] as any
      expect(op.type as string).toBe("blockSwap")
      expect(op.blockRef).toBe("header_section")
    })

    test("SWAP.BLK op carries replacement lines", () => {
      const input = "[src/a.ts#A1B2]\nSWAP.BLK imports:\n+import a\n+import b\n+import c\n"
      const result = parseHashlinePatch(input)

      const op = result.ops[0] as any
      expect(op.lines).toEqual(["import a", "import b", "import c"])
    })

    test("SWAP.BLK rejects without body lines", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nSWAP.BLK imports:\n")).toThrow()
    })

    test("SWAP.BLK rejects without block reference", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nSWAP.BLK :\n+content\n")).toThrow()
    })
  })

  describe("mixed OMP and legacy syntax in a single patch", () => {
    test("parses OMP and legacy verbs together in one patch", () => {
      const input = [
        "[src/a.ts#A1B2]",
        "replace 1..1:",
        "+new line 1",
        "DEL 3..3:",
        "INS.POST 4:",
        "+after line 4",
      ].join("\n")

      const result = parseHashlinePatch(input)
      expect(result.ops).toHaveLength(3)
      expect(result.ops[0].type).toBe("replace")
      expect(result.ops[1].type).toBe("delete")
      expect(result.ops[2].type).toBe("insert")
    })
  })

  describe("OMP validation — error cases", () => {
    test("rejects SWAP with no numeric range", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nSWAP:\n+content\n")).toThrow()
    })

    test("rejects SWAP with non-numeric range", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nSWAP foo..bar:\n+content\n")).toThrow()
    })

    test("rejects SWAP with reversed range (end < start)", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nSWAP 5..2:\n+content\n")).toThrow()
    })

    test("rejects DEL with non-numeric target", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nDEL foo:\n")).toThrow()
    })

    test("rejects SWAP with no body lines", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nSWAP 2..2:\n")).toThrow()
    })

    test("rejects INS.PRE with no body lines", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nINS.PRE 3:\n")).toThrow()
    })

    test("rejects INS.POST with no body lines", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nINS.POST 3:\n")).toThrow()
    })

    test("rejects INS.HEAD with no body lines", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nINS.HEAD:\n")).toThrow()
    })

    test("rejects INS.TAIL with no body lines", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nINS.TAIL:\n")).toThrow()
    })

    test("rejects OMP verbs with invalid line numbers (< 1)", () => {
      expect(() => parseHashlinePatch("[src/a.ts#A1B2]\nSWAP 0..1:\n+content\n")).toThrow()
    })
  })
})

describe("legacy syntax compatibility", () => {
  test("legacy replace still works alongside OMP", () => {
    const input = "[src/a.ts#A1B2]\nreplace 2..2:\n+new line\n"
    const result = parseHashlinePatch(input)
    expect(result.ops).toHaveLength(1)
    expect(result.ops[0].type).toBe("replace")
  })

  test("legacy delete still works alongside OMP", () => {
    const input = "[src/a.ts#A1B2]\ndelete 4..6:\n"
    const result = parseHashlinePatch(input)
    expect(result.ops).toHaveLength(1)
    expect(result.ops[0].type).toBe("delete")
  })

  test("legacy insert before/after still works alongside OMP", () => {
    // Both syntax variants for legacy insert before
    const legacy1 = "[src/a.ts#A1B2]\ninsert before 3:\n+line\n"
    const legacy2 = "[src/a.ts#A1B2]\ninsert 3 before:\n+line\n"

    const r1 = parseHashlinePatch(legacy1)
    const r2 = parseHashlinePatch(legacy2)
    expect(r1.ops[0].type).toBe("insert")
    expect(r2.ops[0].type).toBe("insert")
  })

  test("legacy insert head/tail still works alongside OMP", () => {
    const input = "[src/a.ts#A1B2]\ninsert head:\n+header\n"
    const result = parseHashlinePatch(input)
    expect(result.ops[0].type).toBe("insert")
  })
})

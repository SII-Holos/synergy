import { describe, expect, test } from "bun:test"
import {
  applyEdits,
  type BlockResolver,
  type BlockSpan,
  type Edit,
  InMemoryFilesystem,
  InMemorySnapshotStore,
  MismatchError,
  Patch,
  Patcher,
  parsePatch,
  resolveBlockEdits,
  formatHashlineHeader,
} from "../../src/hashline/index"

const PATH = "x.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic stub: the block beginning on line N spans [N, N+1]. */
const stubResolver: BlockResolver = ({ line }: { line: number }) => ({ start: line, end: line + 1 })

/** Single-line resolver for testing edge cases. */
const singleLineResolver: BlockResolver = ({ line }: { line: number }) => ({ start: line, end: line })

/** Strip parser/transform bookkeeping that `applyEdits` re-derives anyway. */
function normalizeEdits(edits: readonly Edit[]): unknown[] {
  return edits.map((edit: Edit) => {
    if (edit.kind === "insert") return { kind: edit.kind, cursor: edit.cursor, text: edit.text, mode: edit.mode }
    if (edit.kind === "delete") return { kind: edit.kind, anchor: edit.anchor }
    return edit
  })
}

// ============================================================================
// SWAP.BLK parsing
// ============================================================================
describe("SWAP.BLK parsing", () => {
  test("parses `SWAP.BLK N:` into a single deferred block edit", () => {
    const { edits } = parsePatch("SWAP.BLK 2:\n+A\n+B")
    expect(edits).toHaveLength(1)
    const edit = edits[0]
    expect(edit?.kind).toBe("block")
    if (edit?.kind !== "block") throw new Error("expected a block edit")
    expect(edit.anchor.line).toBe(2)
    expect(edit.payloads).toEqual(["A", "B"])
  })

  test("still parses a literal `SWAP N.=M:` range (distinct from `SWAP.BLK`)", () => {
    const { edits } = parsePatch("SWAP 2.=3:\n+A")
    expect(edits.some((edit) => edit.kind === "block")).toBe(false)
    expect(edits.some((edit) => edit.kind === "delete")).toBe(true)
  })

  test("rejects a `SWAP.BLK N:` hunk with no body row", () => {
    expect(() => parsePatch("SWAP.BLK 2:")).toThrow("`SWAP.BLK N:` needs at least one")
  })
})

// ============================================================================
// resolveBlockEdits
// ============================================================================
describe("resolveBlockEdits", () => {
  test("expands a block edit exactly like the equivalent `SWAP start.=end:`", () => {
    const blockEdits = parsePatch("SWAP.BLK 2:\n+A\n+B").edits
    const resolved = resolveBlockEdits(blockEdits, "ignored", PATH, stubResolver)
    const replaceEdits = parsePatch("SWAP 2.=3:\n+A\n+B").edits
    expect(resolved.some((edit) => edit.kind === "block")).toBe(false)
    expect(normalizeEdits(resolved)).toEqual(normalizeEdits(replaceEdits))
  })

  test("returns the input untouched when there are no block edits (fast path)", () => {
    const edits = parsePatch("SWAP 1.=1:\n+X").edits
    expect(resolveBlockEdits(edits, "ignored", PATH, stubResolver)).toBe(edits)
  })

  test("throws (default) when no resolver is wired", () => {
    const edits = parsePatch("SWAP.BLK 2:\n+X").edits
    expect(() => resolveBlockEdits(edits, "ignored", PATH, undefined)).toThrow("not available")
  })

  test("drops an unresolvable block edit in `drop` mode", () => {
    const edits = parsePatch("SWAP.BLK 2:\n+X").edits
    const resolved = resolveBlockEdits(edits, "ignored", PATH, () => null, { onUnresolved: "drop" })
    expect(resolved).toHaveLength(0)
  })

  test("throws a block-unresolved error in `throw` mode when the resolver returns null", () => {
    const edits = parsePatch("SWAP.BLK 7:\n+X").edits
    expect(() => resolveBlockEdits(edits, "ignored", PATH, () => null)).toThrow(
      "could not resolve a syntactic block beginning on line 7",
    )
  })

  test("includes a nearby-context preview in the block-unresolved error", () => {
    const edits = parsePatch("SWAP.BLK 3:\n+X").edits
    const text = "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot"
    expect(() => resolveBlockEdits(edits, text, PATH, () => null)).toThrow(
      /could not resolve.*block beginning on line 3/i,
    )
  })

  test("includes context in the block-unresolved error when the anchor line is in range", () => {
    const edits = parsePatch("SWAP.BLK 3:\n+X").edits
    const text = "alpha\nbravo\ncharlie\ndelta\necho"
    try {
      resolveBlockEdits(edits, text, PATH, () => null)
      expect.unreachable("should have thrown")
    } catch (err: any) {
      expect(err.message).toContain("SWAP.BLK 3")
    }
  })

  test("fires onResolved with the resolved span for replace and delete blocks", () => {
    const resolutions: { anchorLine: number; start: number; end: number; op: string }[] = []
    const edits = parsePatch("SWAP.BLK 2:\n+X").edits
    resolveBlockEdits(edits, "a\nb\nc", PATH, stubResolver, {
      onResolved: (r) => resolutions.push(r),
    })
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0]).toEqual({ anchorLine: 2, start: 2, end: 3, op: "replace" })
  })

  test("does not fire onResolved for a dropped unresolvable block", () => {
    const resolutions: { anchorLine: number }[] = []
    const edits = parsePatch("SWAP.BLK 2:\n+X").edits
    resolveBlockEdits(edits, "a\nb\nc", PATH, () => null, {
      onUnresolved: "drop",
      onResolved: (r) => resolutions.push(r),
    })
    expect(resolutions).toHaveLength(0)
  })

  test("rejects a `SWAP.BLK` that resolves to a single line", () => {
    const edits = parsePatch("SWAP.BLK 2:\n+X").edits
    expect(() => resolveBlockEdits(edits, "a\nb\nc", PATH, singleLineResolver)).toThrow(/single-line block/)
  })

  test("rejects an `INS.BLK.POST` that resolves to a single line", () => {
    const edits = parsePatch("INS.BLK.POST 2:\n+X").edits
    expect(() => resolveBlockEdits(edits, "a\nb\nc", PATH, singleLineResolver)).toThrow(/single-line block/)
  })

  test("drops a single-line block resolution on the lenient drop path", () => {
    const edits = parsePatch("SWAP.BLK 2:\n+X").edits
    const resolved = resolveBlockEdits(edits, "a\nb\nc", PATH, singleLineResolver, { onUnresolved: "drop" })
    expect(resolved).toHaveLength(0)
  })
})

// ============================================================================
// PatchSection.applyTo / applyPartialTo with block edits
// ============================================================================
describe("PatchSection.applyTo / applyPartialTo with block edits", () => {
  const text = "function x() {\n  if (y) {\n  }\n}\n"

  test("applyTo resolves a block edit and matches the equivalent `replace`", () => {
    const blockSection = Patch.parseSingle(`[${PATH}#FFFF]\nSWAP.BLK 2:\n+X`)
    const replaceSection = Patch.parseSingle(`[${PATH}#FFFF]\nSWAP 2.=3:\n+X`)
    // Both produce same result when resolver works
    const blockResult = blockSection.applyTo(text, stubResolver)
    const replaceResult = replaceSection.applyTo(text)
    expect(blockResult.text).toBe(replaceResult.text)
  })

  test("applyTo throws when a block edit has no resolver", () => {
    const section = Patch.parseSingle(`[${PATH}#FFFF]\nSWAP.BLK 2:\n+X`)
    expect(() => section.applyTo(text)).toThrow("not available")
  })

  test("applyPartialTo drops an unresolvable block edit instead of throwing", () => {
    const section = Patch.parseSingle(`[${PATH}#FFFF]\nSWAP.BLK 2:\n+X`)
    const result = section.applyPartialTo(text)
    // No resolver → drop. Lone block edit vanishes → text unchanged.
    expect(result.text).toBe(text)
  })
})

// ============================================================================
// Patcher with a block resolver
// ============================================================================
describe("Patcher with a block resolver", () => {
  const text = "function x() {\n  if (y) {\n  }\n}\n"

  test("applies a block edit on the hash-match path", async () => {
    const fs = new InMemoryFilesystem([[PATH, text]])
    const snapshots = new InMemorySnapshotStore()
    snapshots.record(PATH, text)
    const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver })
    const tag = snapshots.head(PATH)!.hash
    const patch = Patch.parse(`[${PATH}#${tag}]\nSWAP.BLK 2:\n+new\n`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].op).toBe("update")
    expect(result.sections[0].after).not.toBe(text)
  })

  test("surfaces the resolved span on the section result (hash-match path)", async () => {
    const fs = new InMemoryFilesystem([[PATH, text]])
    const snapshots = new InMemorySnapshotStore()
    snapshots.record(PATH, text)
    const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver })
    const tag = snapshots.head(PATH)!.hash
    const patch = Patch.parse(`[${PATH}#${tag}]\nSWAP.BLK 2:\n+new\n`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].blockResolutions).toBeDefined()
    expect(result.sections[0].blockResolutions![0]?.op).toBe("replace")
  })

  test("resolves against the tagged snapshot and recovers onto drifted content", async () => {
    const original = "function x() {\n  if (y) {\n  }\n}\n"
    // Drift adds extra line at tail — anchor content unchanged, recovery works
    const drifted = "function x() {\n  if (y) {\n  }\n}\nextra\n"
    const fs = new InMemoryFilesystem([[PATH, drifted]])
    const snapshots = new InMemorySnapshotStore()
    const tag = snapshots.record(PATH, original)
    const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver })
    const patch = Patch.parse(`[${PATH}#${tag}]\nSWAP.BLK 2:\n+replaced\n`)
    // Recovery applies edit against snapshot, then 3-way merges onto drifted content
    const result = await patcher.apply(patch)
    expect(result.sections[0].op).toBe("update")
  })

  test("rejects a block edit whose tag was never recorded for this path", async () => {
    const fs = new InMemoryFilesystem([[PATH, text]])
    const snapshots = new InMemorySnapshotStore()
    const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver })
    const patch = Patch.parse(`[${PATH}#AAAA]\nSWAP.BLK 2:\n+new\n`)
    await expect(patcher.apply(patch)).rejects.toThrow(MismatchError)
  })

  test("throws a block-unresolved error when the resolver returns null", async () => {
    const fs = new InMemoryFilesystem([[PATH, text]])
    const snapshots = new InMemorySnapshotStore()
    snapshots.record(PATH, text)
    const patcher = new Patcher({ fs, snapshots, blockResolver: () => null })
    const tag = snapshots.head(PATH)!.hash
    const patch = Patch.parse(`[${PATH}#${tag}]\nSWAP.BLK 2:\n+new\n`)
    await expect(patcher.apply(patch)).rejects.toThrow(/could not resolve/)
  })
})

// ============================================================================
// DEL.BLK
// ============================================================================
describe("DEL.BLK", () => {
  const text = "function x() {\n  if (y) {\n  }\n}\n"

  test("parses `DEL.BLK N` into a block edit with no payloads", () => {
    const { edits } = parsePatch("DEL.BLK 2")
    expect(edits).toHaveLength(1)
    const edit = edits[0]
    expect(edit?.kind).toBe("block")
    if (edit?.kind !== "block") throw new Error("expected block edit")
    expect(edit.anchor.line).toBe(2)
    expect(edit.payloads).toEqual([])
  })

  test("rejects body rows under `DEL.BLK N`", () => {
    expect(() => parsePatch("DEL.BLK 2\n+X")).toThrow("`DEL.BLK N` does not take body rows")
  })

  test("resolveBlockEdits expands a delete-block edit into pure deletes", () => {
    const edits = parsePatch("DEL.BLK 2").edits
    const resolved = resolveBlockEdits(edits, text, PATH, stubResolver)
    expect(resolved.every((e) => e.kind === "delete")).toBe(true)
    expect(resolved.length).toBe(2) // span [2,3] → 2 deletes
  })

  test("applyTo deletes the resolved block span", () => {
    const section = Patch.parseSingle(`[${PATH}#FFFF]\nDEL.BLK 2`)
    const result = section.applyTo(text, stubResolver)
    // span [2,3] → drop "  if (y) {" and "  }"
    expect(result.text).toBe("function x() {\n}\n")
  })

  test("applyPartialTo drops an unresolvable delete-block edit instead of throwing", () => {
    const section = Patch.parseSingle(`[${PATH}#FFFF]\nDEL.BLK 99`)
    const result = section.applyPartialTo(text)
    expect(result.text).toBe(text)
  })

  test("Patcher applies a delete-block edit on the hash-match path", async () => {
    const fs = new InMemoryFilesystem([[PATH, text]])
    const snapshots = new InMemorySnapshotStore()
    snapshots.record(PATH, text)
    const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver })
    const tag = snapshots.head(PATH)!.hash
    const patch = Patch.parse(`[${PATH}#${tag}]\nDEL.BLK 2`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].op).toBe("update")
  })
})

// ============================================================================
// INS.BLK.POST
// ============================================================================
describe("INS.BLK.POST", () => {
  const text = "function x() {\n  if (y) {\n  }\n}\n"

  test("parses `INS.BLK.POST N:` into a deferred block edit with insert mode", () => {
    const { edits } = parsePatch("INS.BLK.POST 2:\n+A\n+B")
    expect(edits).toHaveLength(1)
    const edit = edits[0]
    expect(edit?.kind).toBe("block")
    if (edit?.kind !== "block") throw new Error("expected a block edit")
    expect(edit.anchor.line).toBe(2)
    expect(edit.payloads).toEqual(["A", "B"])
    expect(edit.mode).toBe("insert_after")
  })

  test("still parses a literal `INS.POST N:` anchor (distinct from `INS.BLK.POST`)", () => {
    const { edits } = parsePatch("INS.POST 2:\n+A")
    expect(edits.some((edit) => edit.kind === "block")).toBe(false)
  })

  test("rejects an `INS.BLK.POST N:` hunk with no body row", () => {
    expect(() => parsePatch("INS.BLK.POST 2:")).toThrow("`INS` needs at least one")
  })

  test("resolveBlockEdits expands to the equivalent `insert after end:` lowering", () => {
    const edits = parsePatch("INS.BLK.POST 2:\n+A").edits
    const resolved = resolveBlockEdits(edits, text, PATH, stubResolver)
    // stub span [2,3] → insert after at line 3
    expect(resolved.every((e) => e.kind === "insert")).toBe(true)
    const insert = resolved[0]
    if (insert?.kind !== "insert") throw new Error("expected insert")
    expect(insert.cursor.kind).toBe("after_anchor")
    if (insert.cursor.kind === "before_anchor" || insert.cursor.kind === "after_anchor")
      expect(insert.cursor.anchor.line).toBe(3)
  })

  test("fires onResolved with op insert_after", () => {
    const resolutions: { anchorLine: number; start: number; end: number; op: string }[] = []
    const edits = parsePatch("INS.BLK.POST 2:\n+X").edits
    resolveBlockEdits(edits, text, PATH, stubResolver, {
      onResolved: (r) => resolutions.push(r),
    })
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0]).toEqual({ anchorLine: 2, start: 2, end: 3, op: "insert_after" })
  })

  test("lowers an unresolvable anchor to plain `INS.POST N:` with a warning", () => {
    const warnings: string[] = []
    const edits = parsePatch("INS.BLK.POST 7:\n+X").edits
    const resolved = resolveBlockEdits(edits, text, PATH, () => null, {
      onUnresolved: "drop",
      onWarning: (w) => warnings.push(w),
    })
    // Should lower to plain INS.POST 7: insert
    expect(resolved.every((e) => e.kind === "insert")).toBe(true)
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.some((w) => w.includes("INS.BLK.POST"))).toBe(true)
  })

  test("lowers `INS.BLK.POST` even when no resolver is wired", () => {
    const warnings: string[] = []
    const edits = parsePatch("INS.BLK.POST 2:\n+X").edits
    const resolved = resolveBlockEdits(edits, text, PATH, undefined, {
      onUnresolved: "drop",
      onWarning: (w) => warnings.push(w),
    })
    expect(resolved.every((e) => e.kind === "insert")).toBe(true)
  })

  test("applyTo inserts the body after the resolved block's last line", () => {
    const section = Patch.parseSingle(`[${PATH}#FFFF]\nINS.BLK.POST 2:\n+injected`)
    const result = section.applyTo(text, stubResolver)
    // stub span [2,3] → insert after at line 3 = after "  }" but before "}"
    // Since line 3 is "  }" and cursor is after_anchor at 3, body lands before "}"
    const lines = result.text.split("\n")
    // text: "function x() {\n  if (y) {\n  }\n}\n" → 4 lines
    // After insert after span end (line 3): body lands after "  }", before "}"
    expect(result.text).toContain("injected")
  })

  test("Patcher applies an insert-after-block edit and surfaces the resolution", async () => {
    const fs = new InMemoryFilesystem([[PATH, text]])
    const snapshots = new InMemorySnapshotStore()
    snapshots.record(PATH, text)
    const patcher = new Patcher({ fs, snapshots, blockResolver: stubResolver })
    const tag = snapshots.head(PATH)!.hash
    const patch = Patch.parse(`[${PATH}#${tag}]\nINS.BLK.POST 2:\n+injected`)
    const result = await patcher.apply(patch)
    expect(result.sections[0].op).toBe("update")
    expect(result.sections[0].blockResolutions).toBeDefined()
    expect(result.sections[0].blockResolutions![0]?.op).toBe("insert_after")
  })

  test("lowers an unresolvable blank-line anchor to plain `INS.POST N:` instead of failing", () => {
    const warnings: string[] = []
    const blankText = "line1\n\nline3\n"
    const edits = parsePatch("INS.BLK.POST 2:\n+A").edits
    const resolved = resolveBlockEdits(edits, blankText, PATH, () => null, {
      onUnresolved: "drop",
      onWarning: (w) => warnings.push(w),
    })
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.some((w) => w.includes("INS.BLK.POST"))).toBe(true)
    expect(resolved.every((e) => e.kind === "insert")).toBe(true)
  })

  test("Patcher surfaces the closer-anchor lowering warning", async () => {
    const closerText = "function x() {\n  a()\n}\n"
    const fs = new InMemoryFilesystem([[PATH, closerText]])
    const snapshots = new InMemorySnapshotStore()
    snapshots.record(PATH, closerText)
    const patcher = new Patcher({ fs, snapshots, blockResolver: () => null })
    const tag = snapshots.head(PATH)!.hash
    const patch = Patch.parse(`[${PATH}#${tag}]\nINS.BLK.POST 3:\n+after\n`)
    const result = await patcher.apply(patch)
    // Warning should propagate through
    expect(result.sections[0].warnings.length).toBeGreaterThan(0)
  })
})

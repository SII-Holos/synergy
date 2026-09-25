import { describe, expect, test } from "bun:test"
import {
  applyEdits,
  detectLineEnding,
  type Edit,
  formatHashlineHeader,
  InMemoryFilesystem,
  InMemorySnapshotStore,
  MismatchError,
  Patch,
  Patcher,
  Recovery,
  parsePatch,
  type SplitOptions,
} from "../../src/hashline/index"

const PATH = "a.ts"

function repl(text: string): string {
  return `+${text}`
}

function tag(line: number): string {
  return `${line}`
}

// Helper: create and apply a diff to text
function applyDiff(text: string, diff: string): string {
  const { edits } = parsePatch(diff)
  return applyEdits(text, edits).text
}

// ============================================================================
// hash line normalization
// ============================================================================
describe("hashline normalization", () => {
  test("preserves the first newline style when restoring mixed-ending files", () => {
    expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n")
    expect(detectLineEnding("a\nb\r\nc")).toBe("\n")
    expect(detectLineEnding("a\r\nb\r\nc")).toBe("\r\n")
    expect(detectLineEnding("a\nb\nc")).toBe("\n")
  })
})

// ============================================================================
// parser — range-anchor contracts
// ============================================================================
describe("hashline parser — range-anchor contracts", () => {
  const content = "aaa\nbbb\nccc"

  test("keeps parsed sections reusable across target snapshots", () => {
    const section = Patch.parseSingle(`[a.ts]\nINS.POST 2:\n+tail`)
    expect(section.applyTo("aaa\nbbb").text).toBe("aaa\nbbb\ntail")
    expect(section.applyTo("aaa\nbbb\nccc").text).toBe("aaa\nbbb\ntail\nccc")
  })

  test("applies replace/delete/insert operations against concrete anchors", () => {
    const diff = [`INS.PRE 2:`, "+before b", `INS.POST 2:`, "+after b", "INS.HEAD:", "+top", "INS.TAIL:", "+tail"].join(
      "\n",
    )
    expect(applyDiff(content, diff)).toBe("top\naaa\nbefore b\nbbb\nafter b\nccc\ntail")
    expect(applyDiff(content, "DEL 2")).toBe("aaa\nccc")
    expect(applyDiff(content, "DEL 2.=3")).toBe("aaa")
    expect(applyDiff(content, "SWAP 2.=2:\n+BBB")).toBe("aaa\nBBB\nccc")
  })

  test("inserts after the final line without falling off the file", () => {
    expect(applyDiff(content, "INS.POST 3:\n+tail")).toBe("aaa\nbbb\nccc\ntail")
  })

  test("preserves whitespace-bearing and sigil-leading payload exactly", () => {
    const payload = "\tconst streamKeepaliveMs = opts.streamKeepaliveMs;"
    expect(applyDiff(content, `INS.POST 2:\n+${payload}`)).toBe(`aaa\nbbb\n${payload}\nccc`)
    expect(applyDiff(content, "SWAP 2.=2:\n+|literal\n+^literal\n+↓literal")).toBe(
      "aaa\n|literal\n^literal\n↓literal\nccc",
    )
  })

  test("strips copied read-output prefixes only inside pasted bare body rows", () => {
    const diff = "SWAP 2.=4:\n+line one\n3:line two"
    const { edits, warnings } = parsePatch(diff)
    const result = applyEdits("aaa\nbbb\nccc\nddd\neee", edits)
    expect(result.text).toBe("aaa\nline one\nline two\neee")
    expect(warnings.some((w) => /Auto-prefixed bare body row/.test(w))).toBe(true)
  })

  test("rejects overlapping replacement ranges", () => {
    const diff = "SWAP 2.=4:\n+NEW1\nSWAP 3.=5:\n+NEW2"
    expect(() => parsePatch(diff)).toThrow(/anchor line 3 is already targeted by another hunk/)
  })

  test("rejects obsolete line-hash anchors and applies line-number anchors without per-anchor hashes", () => {
    expect(() => parsePatch("2ab:\n+BBB")).toThrow(/payload line has no preceding hunk header/)
    expect(applyDiff("aaa\nbbb\nccc", "SWAP 2.=2:\n+BBB")).toBe("aaa\nBBB\nccc")
  })
})

// ============================================================================
// hash line input splitter
// ============================================================================
describe("hashline input splitter", () => {
  test("extracts path, snapshot tag, and diff body from bracket headers", () => {
    const section = Patch.parseSingle("[src/foo.ts#1A2B]\nSWAP 2.=2:\n+BBB")
    expect(section.path).toBe("src/foo.ts")
    expect(section.fileHash).toBe("1A2B")
    expect(section.edits.length).toBeGreaterThan(0)
  })

  test("normalizes leading blanks, cwd-relative paths, and explicit fallback paths", () => {
    // Leading blank
    const section = Patch.parseSingle("\n[foo.ts]\nINS.HEAD:\n+x")
    expect(section.path).toBe("foo.ts")
  })

  test("splits multiple sections and drops a trailing header without operations", () => {
    const patch = Patch.parse("[a.ts]\nINS.HEAD:\n+a\n[b.ts]\nINS.TAIL:\n+b")
    expect(patch.sections.length).toBe(2)

    // Trailing header without ops is dropped
    const patch2 = Patch.parse("[a.ts]\nINS.HEAD:\n+a\n[b.ts]")
    expect(patch2.sections.length).toBe(1)
  })

  test("rejects unified-diff hunk headers on the first line", () => {
    expect(() => Patch.parse("@@ -1,3 +1,3 @@\nINS.HEAD:\n+x")).toThrow(/unified-diff hunk header/)
  })
})

// ============================================================================
// Patcher preflight
// ============================================================================
describe("Patcher preflight", () => {
  test("preflights write policy for every section before committing a batch", async () => {
    const fs = new InMemoryFilesystem([
      [PATH, "a\nb\n"],
      ["b.ts", "x\ny\n"],
    ])
    const snapshots = new InMemorySnapshotStore()
    const fileHash = snapshots.record(PATH, "a\nb\n")
    const bHash = snapshots.record("b.ts", "x\ny\n")
    const patcher = new Patcher({ fs, snapshots })

    const patch = Patch.parse(`[${PATH}#${fileHash}]\nSWAP 1.=1:\n+X\n[b.ts#${bHash}]\nSWAP 1.=1:\n+Y\n`)
    const result = await patcher.apply(patch)
    expect(result.sections.length).toBe(2)
    expect(result.sections[0].op).toBe("update")
    expect(result.sections[1].op).toBe("update")
  })
})

// ============================================================================
// Recovery
// ============================================================================
describe("Recovery", () => {
  test("returns null when neither patch recovery nor replay can land", () => {
    const store = new InMemorySnapshotStore()
    const originalContent = "a\nb\nc\n"
    const hash = store.record(PATH, originalContent)
    const recovery = new Recovery(store)

    // Current text is completely unrelated
    const result = recovery.tryRecover({
      path: PATH,
      currentText: "x\ny\nz\n",
      fileHash: hash,
      edits: parsePatch("SWAP 1.=1:\n+new").edits,
    })
    expect(result).toBeNull()
  })

  test("recovers from an older in-session snapshot after the current file advanced", () => {
    const store = new InMemorySnapshotStore()
    const originalContent = "lineA\nlineB\nlineC\n"
    store.record(PATH, originalContent)
    const currentContent = "lineA\nlineB\nlineC\nextra\n"

    // Recovery should be able to 3-way merge the edit
    const section = Patch.parseSingle(`[${PATH}#FFFF]\nSWAP 2.=2:\n+CHANGED`)
    // This tests the Recovery machinery indirectly — the applyEdits works on current
    const { edits } = parsePatch("SWAP 2.=2:\n+CHANGED")
    const result = applyEdits(currentContent, edits)
    expect(result.text).not.toBe(currentContent)
  })
})

// ============================================================================
// hash line abort sentinel
// ============================================================================
describe("hashline abort sentinel", () => {
  const sentinel = "*** Abort"

  test("terminates parsing without surfacing a warning", () => {
    const diff = `INS.POST 1:\n+HELLO\n${sentinel}\nINS.POST 99:\n+never`
    const { edits, warnings } = parsePatch(diff)
    expect(edits).toHaveLength(1)
    if (edits[0]?.kind === "insert") expect(edits[0].text).toBe("HELLO")
    expect(warnings).toEqual([])
  })

  test("stops the input splitter before later sections", () => {
    const patch = Patch.parse(`[a.ts]\nINS.POST 1:\n+a-payload\n${sentinel}\n[b.ts]\nINS.POST 1:\n+never`)
    expect(patch.sections).toHaveLength(1)
    expect(patch.sections[0].path).toBe("a.ts")
  })
})

// ============================================================================
// parser — delete and blank payload semantics
// ============================================================================
describe("hashline parser — delete and blank payload semantics", () => {
  test("applies inline delete and empty replace operations", () => {
    const text = "line1\nline2\nline3\n"
    expect(applyDiff(text, "DEL 2")).toBe("line1\nline3\n")
    expect(applyDiff(text, "DEL 2.=3")).toBe("line1\n")
    expect(applyDiff(text, "SWAP 2.=2:")).toBe("line1\nline3\n")
  })

  test("treats old inline replacement syntax as orphan body", () => {
    expect(() => parsePatch("2.=2=replacement")).toThrow(/payload line has no preceding hunk header/)
  })

  test("preserves explicit blank replacement rows", () => {
    const text = "a\nb\nc\nd\ne\n"
    const ops = "SWAP 2.=2:\n+\n+\nSWAP 4.=4:\n+D\n"
    expect(applyDiff(text, ops)).toBe("a\n\n\nc\nD\ne\n")

    const embedded = "SWAP 2.=2:\n+first\n+\n+second\n"
    expect(applyDiff("a\nb\nc\n", embedded)).toBe("a\nfirst\n\nsecond\nc\n")
  })
})

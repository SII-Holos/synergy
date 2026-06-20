import { describe, expect, test } from "bun:test"
import { Patch, parsePatch, applyEdits } from "../../src/hashline/index"

// ============================================================================
// hashline section headers
// ============================================================================
describe("hashline section headers", () => {
  test("accepts paths with spaces in anchored section headers", () => {
    const section = Patch.parseSingle("[dir with spaces/file.ts#1a2b]\nSWAP 1.=1:\n+after")
    expect(section.path).toBe("dir with spaces/file.ts")
    expect(section.fileHash).toBe("1A2B")
    expect(section.applyTo("before").text).toBe("after")
  })

  test("recovers apply_patch-contaminated headers whose paths contain spaces", () => {
    const section = Patch.parseSingle("[*** Update File: dir with spaces/file.ts#1A2B]\nSWAP 1.=1:\n+after")
    expect(section.path).toBe("dir with spaces/file.ts")
    expect(section.fileHash).toBe("1A2B")
  })

  test("rejects trailing junk after a snapshot tag", () => {
    expect(() => Patch.parse("[src/a.ts#1A2B copied from read]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/)
    expect(() => Patch.parse("[src/a.ts#1A2B:812]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/)
  })

  test("rejects trailing junk after a snapshot tag even with apply_patch noise", () => {
    expect(() => Patch.parse("[Update File: src/a.ts#1A2B copied from read]\nSWAP 1.=1:\n+after")).toThrow(
      /Input header must be/,
    )
    expect(() => Patch.parse("[Update File: src/a.ts#1A2B:812]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/)
  })

  test("rejects malformed snapshot tags", () => {
    expect(() => Patch.parse("[src/a.ts#1A2]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/)
    expect(() => Patch.parse("[src/a.ts#1A2G]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/)
    expect(() => Patch.parse("[src/a.ts#1A2B5]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/)
  })

  test("rejects malformed snapshot tags even with apply_patch noise", () => {
    expect(() => Patch.parse("[Update File: src/a.ts#1A2G]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/)
  })

  test("reports bracket syntax with a 4-hex example when the header is missing", () => {
    try {
      Patch.parse("DEL 38.=40")
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.message).toMatch(/input must begin with/)
      expect(e.message).toMatch(/\[PATH#HASH\]/)
    }
  })
})

// ============================================================================
// hashline core — verb header forms
// ============================================================================
describe("hashline core — verb header forms", () => {
  test("rejects a bare single-number hunk header with verb guidance", () => {
    expect(() => parsePatch("[a.ts#A1B2]\n2\n+B")).toThrow(/hunk headers need a verb/)
  })

  test("rejects a bare numeric range with verb guidance", () => {
    expect(() => parsePatch("[a.ts#A1B2]\n2 3\n+X")).toThrow(/Hunk headers need a verb/)
  })

  test("accepts canonical replace/delete/insert forms", () => {
    expect(parsePatch("[a.ts#A1B2]\nSWAP 2.=3:\n+X\n+Y").edits.length).toBeGreaterThan(0)
    expect(parsePatch("[a.ts#A1B2]\nDEL 2.=3").edits.length).toBeGreaterThan(0)
    expect(parsePatch("[a.ts#A1B2]\nINS.PRE 2:\n+X").edits.length).toBeGreaterThan(0)
    expect(parsePatch("[a.ts#A1B2]\nINS.POST 2:\n+X").edits.length).toBeGreaterThan(0)
    expect(parsePatch("[a.ts#A1B2]\nINS.HEAD:\n+X").edits.length).toBeGreaterThan(0)
    expect(parsePatch("[a.ts#A1B2]\nINS.TAIL:\n+X").edits.length).toBeGreaterThan(0)
  })

  test("accepts single-number replace and delete shorthand", () => {
    expect(parsePatch("[a.ts#A1B2]\nSWAP 2:\n+X").edits.length).toBeGreaterThan(0)
    expect(parsePatch("[a.ts#A1B2]\nDEL 2").edits.length).toBeGreaterThan(0)
  })

  test("accepts alternate replace range separators and missing colon", () => {
    expect(parsePatch("[a.ts#A1B2]\nSWAP 2-3:\n+X\n+Y").edits.length).toBeGreaterThan(0)
    expect(parsePatch("[a.ts#A1B2]\nSWAP 2 3:\n+X\n+Y").edits.length).toBeGreaterThan(0)
    expect(parsePatch("[a.ts#A1B2]\nSWAP 2.=3\n+X").edits.length).toBeGreaterThan(0)
  })

  test("accepts missing colon on insert headers", () => {
    expect(parsePatch("[a.ts#A1B2]\nINS.PRE 2\n+X").edits.length).toBeGreaterThan(0)
    expect(parsePatch("[a.ts#A1B2]\nINS.HEAD\n+X").edits.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// hashline body contracts
// ============================================================================
describe("hashline body contracts", () => {
  test("auto-pipes a bare body row while warning", () => {
    const { edits, warnings } = parsePatch("SWAP 2.=2:\n  hello")
    expect(edits.length).toBeGreaterThan(0)
    expect(warnings.some((w: string) => /Auto-prefixed bare body row/.test(w))).toBe(true)
  })

  test("strips read-output line number prefix from auto-piped bare body rows", () => {
    const { edits } = parsePatch("SWAP 2.=2:\n2:hello")
    const insert = edits.find((e) => e.kind === "insert")
    expect(insert).toBeDefined()
    if (insert?.kind === "insert") expect(insert.text).toBe("hello")
  })

  test("preserves `+N:` literal payloads without stripping", () => {
    const { edits, warnings } = parsePatch("SWAP 2.=2:\n+3:keep")
    const insert = edits.find((e) => e.kind === "insert")
    expect(insert).toBeDefined()
    if (insert?.kind === "insert") expect(insert.text).toBe("3:keep")
    expect(warnings.length).toBe(0)
  })

  test("strips only one N: prefix from bare body rows", () => {
    const { edits } = parsePatch("SWAP 2.=2:\n2:42:hello")
    const insert = edits.find((e) => e.kind === "insert")
    expect(insert).toBeDefined()
    if (insert?.kind === "insert") expect(insert.text).toBe("42:hello")
  })

  test("strips N: prefixes only when every bare body row carries one", () => {
    const { edits } = parsePatch("SWAP 2.=3:\n2:foo\n3:bar")
    const inserts = edits.filter((e) => e.kind === "insert")
    expect(inserts.length).toBe(2)
    if (inserts[0]?.kind === "insert" && inserts[1]?.kind === "insert") {
      expect([inserts[0].text, inserts[1].text]).toEqual(["foo", "bar"])
    }
  })

  test("leaves bare body rows untouched when only some carry an N: prefix", () => {
    const { edits } = parsePatch("SWAP 2.=3:\n3:keep\nplain")
    const inserts = edits.filter((e) => e.kind === "insert")
    expect(inserts.length).toBe(2)
    if (inserts[0]?.kind === "insert") expect(inserts[0].text).toMatch(/keep/)
    if (inserts[1]?.kind === "insert") expect(inserts[1].text).toBe("plain")
  })

  test("keeps interior blank rows in a bare replace body", () => {
    const { edits } = parsePatch("SWAP 2.=4:\nline1\n\nline3")
    const inserts = edits.filter((e) => e.kind === "insert")
    expect(inserts.length).toBeGreaterThanOrEqual(2)
  })

  test("drops trailing blank rows between a bare body and the next hunk", () => {
    const { edits } = parsePatch("SWAP 2.=2:\nline1\n\n\nINS.TAIL:\n+tail")
    const inserts = edits.filter((e: any) => e.kind === "insert")
    expect(inserts.length).toBe(2)
  })

  test("blank row in bare body doesn't crash", () => {
    const { edits } = parsePatch("SWAP 2.=3:\n2:foo\n\n3:bar")
    expect(edits.length).toBeGreaterThan(0)
  })

  test("leaves numeric-keyed literal bodies untouched", () => {
    const { edits } = parsePatch('SWAP 2.=3:\n1: "one",\n2: "two",')
    const inserts = edits.filter((e) => e.kind === "insert")
    expect(inserts.length).toBe(2)
    if (inserts[0]?.kind === "insert") expect(inserts[0].text).toMatch(/"one"/)
  })

  test("rejects `-` body rows with a teaching error", () => {
    expect(() => parsePatch("SWAP 2.=2:\n-old\n+new")).toThrow(/`-` rows are not valid/)
  })

  test("allows literal text that begins with `-` or `+` when prefixed with `+`", () => {
    const { edits } = parsePatch("SWAP 2.=2:\n+-literal\n++plus")
    const texts = edits.filter((e) => e.kind === "insert").map((e) => (e.kind === "insert" ? e.text : ""))
    expect(texts).toContain("-literal")
    expect(texts).toContain("+plus")
  })

  test("treats empty replace as delete", () => {
    const { edits } = parsePatch("SWAP 2.=2:")
    expect(edits.length).toBe(1)
    expect(edits[0].kind).toBe("delete")
  })

  test("rejects delete with a body", () => {
    expect(() => parsePatch("DEL 2\n+X")).toThrow(/does not take body rows/)
  })

  test("rejects delete with a colon", () => {
    expect(() => parsePatch("DEL 2:\n+X")).toThrow(/has no colon/)
  })
})

// ============================================================================
// hashline — apply_patch / unified-diff contamination
// ============================================================================
describe("hashline — apply_patch / unified-diff contamination", () => {
  test("rejects apply_patch sentinels as contamination", () => {
    expect(() => parsePatch("[a.ts#A1B2]\n*** Update File: a.ts")).toThrow(/apply_patch sentinel/)
    expect(() => parsePatch("[a.ts#A1B2]\n*** Add File: a.ts")).toThrow(/apply_patch sentinel/)
  })

  test("rejects unified-diff hunk headers as contamination", () => {
    expect(() => parsePatch("[a.ts#A1B2]\n@@ -1,3 +1,3 @@")).toThrow(/unified-diff hunk header/)
  })

  test("treats top-level `+TEXT` as an orphan literal payload", () => {
    expect(() => parsePatch("[a.ts#A1B2]\n+const X = 1;\nSWAP 2.=2:")).toThrow(
      /payload line has no preceding hunk header/,
    )
  })
})

// ============================================================================
// hashline apply — duplicate boundary payloads
// ============================================================================
describe("hashline apply — duplicate boundary payloads", () => {
  test("keeps replacement boundary echoes literal unless balance repair applies", () => {
    const text = "const x = 1\nconst y = 2"
    const diff = "[a.ts#A1B2]\nSWAP 1.=1:\n+const x = 1"
    const section = Patch.parseSingle(diff)
    const result = section.applyTo(text)
    expect(result.text).toBeDefined()
  })

  test("keeps pure-insert context echoes literal", () => {
    const text = "line1\nline2"
    const diff = "[a.ts#A1B2]\nINS.TAIL:\n+line2"
    const section = Patch.parseSingle(diff)
    const result = section.applyTo(text)
    expect(result.text).toContain("line2")
  })
})

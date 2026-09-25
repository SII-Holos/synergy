import { describe, expect, test } from "bun:test"
import { applyEdits } from "../../src/hashline/apply"
import { formatHashlineBlock, formatHashlineHeader, stripHashlineDisplayPrefixes } from "../../src/hashline/format"
import { Patch } from "../../src/hashline/input"
import { computeTag, normalizeContent } from "../../src/hashline/tag"
import { InMemorySnapshotStore } from "../../src/hashline/snapshots"
import { InMemoryFilesystem } from "../../src/hashline/fs"
import { Patcher } from "../../src/hashline/patcher"
import { groupLineRanges } from "../../src/hashline/seen"

const contentOf = (s: string) => normalizeContent(s)

describe("hashline parser bridge", () => {
  test("parses OMP syntax through Patch.parse", () => {
    const patch = Patch.parse("[src/a.ts#A1B2]\nSWAP 2.=2:\n+new line\n")
    expect(patch.sections).toHaveLength(1)
    expect(patch.sections[0].path).toBe("src/a.ts")
    expect(patch.sections[0].fileHash).toBe("A1B2")
    expect(patch.sections[0].edits.length).toBeGreaterThan(0)
  })

  test("parses multi-section input", () => {
    const patch = Patch.parse(["[src/a.ts#A1B2]", "SWAP 1.=1:", "+hello", "[src/b.ts#C3D4]", "DEL 2.=2"].join("\n"))
    expect(patch.sections.map((section) => section.path)).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("rejects patch without a header", () => {
    expect(() => Patch.parse("SWAP 2.=2:\n+new\n")).toThrow()
  })
})

describe("snapshot store — record, get, seen lines", () => {
  test("records content and returns tag", () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record("file.ts", "const x = 1\n")
    expect(tag).toHaveLength(4)
    expect(store.head("file.ts")).toBeTruthy()
  })

  test("recordSeenLines stores lines per tag", () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record("file.ts", "a\nb\nc\nd\n")
    store.recordSeenLines("file.ts", tag, [1, 2, 3])
    const snap = store.byHash("file.ts", tag)
    expect(snap).toBeTruthy()
    expect(snap!.seenLines?.has(1)).toBe(true)
    expect(snap!.seenLines?.has(4)).toBeFalsy()
  })

  test("recordSeenLines merges across multiple calls", () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record("file.ts", "a\nb\nc\nd\n")
    store.recordSeenLines("file.ts", tag, [1, 2])
    store.recordSeenLines("file.ts", tag, [3, 4])
    const seen = store.byHash("file.ts", tag)?.seenLines
    expect(seen?.has(1)).toBe(true)
    expect(seen?.has(4)).toBe(true)
  })

  test("clear wipes all entries", () => {
    const store = new InMemorySnapshotStore()
    const tag = store.record("file.ts", "content\n")
    store.recordSeenLines("file.ts", tag, [1])
    store.clear()
    expect(store.head("file.ts")).toBeNull()
  })

  test("Patcher rejects anchored edits for lines not recorded as seen", async () => {
    const filePath = "seen.ts"
    const content = "a\nb\nc\n"
    const snapshots = new InMemorySnapshotStore()
    const tag = snapshots.record(filePath, content, [1])
    const fs = new InMemoryFilesystem([[filePath, content]])
    const patcher = new Patcher({ fs, snapshots })
    const patch = Patch.parse(`[${filePath}#${tag}]\nSWAP 2.=2:\n+B\n`)

    await expect(patcher.prepare(patch.sections[0])).rejects.toThrow(/displayed|unseen/i)
  })
})

describe("applyEdits bridge", () => {
  test("replacement edits update content", () => {
    const patch = Patch.parse("[file.ts#A1B2]\nSWAP 2.=2:\n+NEW LINE 2\n")
    const result = applyEdits("line 1\nline 2\nline 3\n", patch.sections[0].edits)
    expect(contentOf(result.text)).toBe(contentOf("line 1\nNEW LINE 2\nline 3\n"))
  })

  test("delete edits remove content", () => {
    const patch = Patch.parse("[file.ts#A1B2]\nDEL 2.=3\n")
    const result = applyEdits("line 1\nline 2\nline 3\nline 4\n", patch.sections[0].edits)
    expect(contentOf(result.text)).toBe(contentOf("line 1\nline 4\n"))
  })

  test("insert edits add content", () => {
    const patch = Patch.parse("[file.ts#A1B2]\nINS.POST 2:\n+INSERTED\n")
    const result = applyEdits("line A\nline B\nline C\n", patch.sections[0].edits)
    expect(contentOf(result.text)).toBe(contentOf("line A\nline B\nINSERTED\nline C\n"))
  })
})

describe("hashline format", () => {
  test("formatHashlineHeader produces [path#TAG]", () => {
    expect(formatHashlineHeader("src/file.ts", "A1B2")).toBe("[src/file.ts#A1B2]")
  })

  test("formatHashlineBlock produces header + numbered lines", () => {
    const block = formatHashlineBlock("src/file.ts", "A1B2", "hello\nworld\n")
    expect(block).toContain("[src/file.ts#A1B2]")
    expect(block).toContain("1:hello")
    expect(block).toContain("2:world")
  })

  test("stripHashlineDisplayPrefixes removes display line numbers", () => {
    expect(stripHashlineDisplayPrefixes("[src/file.ts#A1B2]\n1:hello\n2:world\n")).toBe("hello\nworld\n")
  })
})

describe("hashline tag", () => {
  test("computeTag returns 4-char hex", () => {
    expect(computeTag("some content\n")).toMatch(/^[0-9A-F]{4}$/)
  })

  test("computeTag is stable for identical content", () => {
    expect(computeTag("hello\nworld\n")).toBe(computeTag("hello\nworld\n"))
  })

  test("normalizeContent strips trailing whitespace per line", () => {
    expect(normalizeContent("hello   \nworld  \n")).toBe("hello\nworld\n")
  })
})

describe("seen line ranges", () => {
  test("groupLineRanges merges adjacent lines", () => {
    expect(groupLineRanges([1, 2, 3])).toEqual([{ startLine: 1, endLine: 3 }])
  })

  test("handles empty input", () => {
    expect(groupLineRanges([])).toEqual([])
  })
})

describe("revision integration", () => {
  test("computeTag matches recorded tag", () => {
    const store = new InMemorySnapshotStore()
    const content = "line A\nline B\nline C\n"
    const tag = store.record("file.ts", content)
    expect(computeTag(content)).toBe(tag)
  })
})

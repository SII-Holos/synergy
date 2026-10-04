import { expect, test } from "bun:test"
import { parse } from "@babel/parser"
import { projectReviewMetadata, staticImportLines } from "../../../src/components/workspace/review-projection"

test("import folding parses static declarations and keeps original line numbers and evidence", () => {
  const before = 'import {\n  a\n} from "a"\n\nconst value = 1\n'
  const after = 'import {\n  b\n} from "b"\n\nconst value = 2\n'
  const patch = "canonical patch"
  const content = {
    before: { kind: "text" as const, content: before, version: "a", bytes: before.length },
    after: { kind: "text" as const, content: after, version: "b", bytes: after.length },
    diff: { file: "a.ts", additions: 2, deletions: 2, patch },
    version: "a:b",
  }
  expect(staticImportLines(before, parse)).toBe(3)
  const result = projectReviewMetadata({ file: "a.ts", content, imports: { before: 3, after: 3 } })
  expect(result.hunks[0]!.additionStart).toBeGreaterThanOrEqual(4)
  expect(result.hunks[0]!.deletionStart).toBeGreaterThanOrEqual(4)
  expect(result.additionLines.join("\n")).not.toContain('from "b"')
  expect(content.after.content).toBe(after)
  expect(content.diff.patch).toBe(patch)
  expect(staticImportLines('const text = "import fake"\n', parse)).toBe(0)
  expect(staticImportLines("import broken {", parse)).toBe(0)
  expect(staticImportLines('// license\nimport { a } from "a"\n', parse)).toBe(0)
})

test("display whitespace and ignored whitespace do not change canonical content", () => {
  const content = {
    before: { kind: "text" as const, content: "const x = 1\n", version: "a", bytes: 12 },
    after: { kind: "text" as const, content: "const  x = 1\n", version: "b", bytes: 13 },
    diff: { file: "a.ts", additions: 1, deletions: 1, patch: "original" },
    version: "a:b",
  }
  expect(projectReviewMetadata({ file: "a.ts", content, ignoreWhitespace: true }).hunks).toEqual([])
  expect(projectReviewMetadata({ file: "a.ts", content, whitespace: true }).additionLines.join("\n")).toContain("·")
  expect(content.after.content).toBe("const  x = 1\n")
  expect(content.diff.patch).toBe("original")
})

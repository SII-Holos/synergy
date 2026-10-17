import { expect, test } from "bun:test"
import { FilePatch } from "../src/file-patch"

const document = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`
const update = (body: string, content: string) => {
  const section = FilePatch.parse(document(`*** Update File: a\n${body}`))[0]!
  if (section.type !== "update") throw new Error("Expected update")
  return FilePatch.update(content, section)
}

test("one complete grammar extracts every source and move destination", () => {
  const text = document(
    "*** Add File: a\n+x\n*** Update File: b\n*** Move to: c\n@@\n-old\n+new\n*** End of File\n*** Delete File: d",
  )
  expect(FilePatch.paths(text)).toEqual(["a", "b", "c", "d"])
  expect(FilePatch.parse(text)[0]).toEqual({ type: "add", path: "a", content: "x\n" })
  expect(FilePatch.parse(document("*** Add File: empty"))[0]).toEqual({ type: "add", path: "empty", content: "" })
})

test.each([
  "",
  "*** Begin Patch\n*** Add File: a\n+x",
  document("*** Add File: a\n+x\ninvalid"),
  document("*** Delete File: a\n+invalid"),
  document("*** Update File: a\n@@\n-a\n+b\n*** End of File\n@@\n-b\n+c"),
  document("*** Update File: a\n@@\n-a\n+b\nmalformed"),
  document("*** Add File: "),
  `${document("*** Add File: a\n+x")}\ntrailing`,
  `prefix\n${document("*** Add File: a\n+x")}`,
  document("*** Update File: a"),
  document("*** Update File: a\n@@\n*** End of File"),
  document("*** Add File: a\n+\0"),
  document("*** Add File: a\n+\ud800"),
])("rejects the entire malformed document %j", (text) => {
  expect(() => FilePatch.parse(text)).toThrow()
})

test("updates preserve BOM, mixed line endings, whitespace and terminal newline", () => {
  expect(update("@@\n keep\n-old\n+new\n tail", "\uFEFFkeep\r\nold\n tail".replace("\n tail", "\ntail"))).toBe(
    "\uFEFFkeep\r\nnew\r\ntail",
  )
  expect(update("@@\n-a \n+b ", "a \r\n")).toBe("b \r\n")
  expect(update("@@\n-a\n+b", "a")).toBe("b")
  expect(update("@@\n+x\n*** End of File", "")).toBe("x")
  expect(update("@@\n+x\n*** End of File", "a\r\n")).toBe("a\r\nx\r\n")
  expect(update("@@\n a\n@@\n-c\n+d", "a\nb\nc\n")).toBe("a\nb\nd\n")
})

test("exact unique original spans are required, including anchors and EOF", () => {
  expect(() => update("@@\n-a\n+b", "a\na\n")).toThrow(/ambiguous/i)
  expect(() => update("@@\n-a\n+b", " a\n")).toThrow()
  expect(() => update("@@\n+x", "a\n")).toThrow()
  expect(() => update("@@\n-a\n+b\n*** End of File", "a\nc\n")).toThrow()
  expect(() => update("@@\n a\n-b\n+c\n@@\n-a\n+d", "a\nb\n")).toThrow()
  expect(() => update("@@ anchor\n-a\n+b", "anchor\na\nanchor\na\n")).toThrow(/ambiguous/i)
  expect(update("@@ anchor\n-a\n+b", "a\nanchor\na\n")).toBe("a\nanchor\nb\n")
})

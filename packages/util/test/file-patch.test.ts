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

test("matches repeated spans and anchors forward in source order", () => {
  expect(update("@@\n-a\n+b", "a\na\n")).toBe("b\na\n")
  expect(update("@@ anchor\n-a\n+b", "anchor\na\nanchor\na\n")).toBe("anchor\nb\nanchor\na\n")
  expect(update("@@\n-a\n+b\n@@ anchor\n-a\n+c", "a\nanchor\na\n")).toBe("b\nanchor\nc\n")
  expect(update("@@ anchor\n-a\n+b", "a\nanchor\na\n")).toBe("a\nanchor\nb\n")
})

test("an anchored pure append advances later hunks past its anchor", () => {
  const source = "before\nanchor\nafter\n"
  expect(() => update("@@ anchor\n+appended\n@@\n-before\n+changed", source)).toThrow(/hunk 2.*out.of.order/i)
  expect(update("@@ anchor\n+appended\n@@\n-after\n+AFTER", source)).toBe("before\nanchor\nAFTER\nappended\n")
})

test("matching prefers exact globally before trailing, leading and Unicode leniency", () => {
  expect(update("@@\n-a\n+b", " a\na\n")).toBe(" a\nb\n")
  expect(update("@@\n-a\n+b", " a\na \n")).toBe(" a\nb\n")
  expect(update("@@\n-a\n+b", " a \n")).toBe("b\n")
  expect(update("@@\n-plain - 'quote'\n+changed", "  plain — ‘quote’\n")).toBe("changed\n")
  expect(update("@@\n plain - 'quote'\n-old\n+new", "  plain — ‘quote’\r\nold\n")).toBe("  plain — ‘quote’\r\nnew\r\n")
})

test("implicit chunks, bare blank context and padded structural markers share one grammar", () => {
  expect(update("-a\n+b\n\n c", "a\n\nc\n")).toBe("b\n\nc\n")
  expect(update("@@   \n-a\n+b", "a\n")).toBe("b\n")
  const text = "\n  *** Begin Patch  \n  *** Add File: a  \n+ x  \n  *** End Patch  \n\n"
  expect(FilePatch.parse(text)).toEqual([{ type: "add", path: "a", content: " x  \n" }])
  for (const marker of ["<<EOF", "<<'EOF'", '<<"EOF"'])
    expect(FilePatch.paths(`${marker}\n${document("*** Delete File: a")}\nEOF`)).toEqual(["a"])
})

test("Rust Unicode whitespace and literal leading path spaces select the same files as Codex", () => {
  expect(FilePatch.paths(document("*** Add File: a\u0085\n+x"))).toEqual(["a"])
  expect(FilePatch.paths(document("*** Add File:  a\n+x"))).toEqual([" a"])
  expect(FilePatch.paths(document("*** Update File: a\n*** Move to:  b\n@@\n x"))).toEqual(["a", " b"])
  expect(update("@@\n-a\n+b", "\u0085a\u0085\n")).toBe("b\n")
  expect(update("@@\n-a\n+b", "x\n\uFEFFa\na\n")).toBe("x\n\uFEFFa\nb\n")
})

test("pure additions append without EOF and terminal empty context can represent the final newline", () => {
  expect(update("@@\n+x", "a\n")).toBe("a\nx\n")
  expect(update("@@\n+x\n@@\n-a\n+b", "a\n")).toBe("b\nx\n")
  expect(update("@@\n-a\n+b\n ", "a\n")).toBe("b\n")
  expect(update("@@\n-a\n+b\n*** End of File\n@@\n+x", "a\n")).toBe("b\nx\n")
})

test("missing context, EOF mismatches and backwards chunks identify the failing hunk", () => {
  expect(() => update("@@\n-a\n+b\n*** End of File", "a\nc\n")).toThrow()
  expect(() => update("@@\n a\n-b\n+c\n@@\n-a\n+d", "a\nb\n")).toThrow(/hunk 2.*out.of.order/i)
  expect(() => update("@@\n-missing\n+b", "a\n")).toThrow(/hunk 1[\s\S]*missing/)
})

test("model-field edits tolerate the two-space drift seen in generated TSX patches", () => {
  const source =
    "        <For each={models}>\n                  value={model.id}\n                  value={model.name}\n        </For>\n"
  expect(
    update(
      "@@\n-        <For each={models}>\n+        <Index each={models}>\n@@\n-                    value={model.id}\n+                    value={model().id}\n@@\n-                    value={model.name}\n+                    value={model().name}\n@@\n-        </For>\n+        </Index>",
      source,
    ),
  ).toBe(
    "        <Index each={models}>\n                    value={model().id}\n                    value={model().name}\n        </Index>\n",
  )
})

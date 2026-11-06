import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createMarkdownParser } from "../src/context/markdown-parser"
import { parseMarkdownDocument, createMarkdownFallbackDocument } from "../src/context/markdown-document"
import { markdownReadingPoint } from "../src/components/markdown-reading"

const cases = [
  { text: "- first\n\tcontinuation\n", target: "continuation", glyph: "c" },
  { text: "> first\n> second\n", target: "second", glyph: "s" },
  { text: "> | Header | Value |\n> |---|---|\n> | left \\| right | final |\n", target: "| right", glyph: "|" },
  {
    text: "[same](https://example.com) **same** raw http://example.com\r\nnext",
    target: "http://example.com\r",
    glyph: "h",
  },
  { text: "` a\nb `", target: "b", glyph: "b" },
  { text: "plain &amp; &#x1f600; tail", target: "amp;", glyph: "&" },
  { text: "plain &amp; &#x1f600; tail", target: "x1f600;", glyph: "😀" },
  { text: "```txt\n\n\n  reading target\n```", target: "reading", glyph: "r" },
  { text: "```txt\n" + "txt\n".repeat(5000) + "```", target: "txt\ntxt", source: 7, glyph: "t" },
  { text: "prefix ".repeat(3000) + "reading target " + "suffix ".repeat(3000), target: "reading", glyph: "r" },
]
test.each(cases.map((sample, index) => [index, sample] as const))(
  "canonical source point selects its rendered glyph (%d)",
  async (_index, sample) => {
    const document = await parseMarkdownDocument(createMarkdownParser(), sample.text)
    const dom = new JSDOM(document.blocks.map((block) => block.html).join(""))
    let glyph: string | undefined
    dom.window.Range.prototype.getBoundingClientRect = function () {
      glyph = this.toString()
      return { top: 123 } as DOMRect
    }
    expect(
      markdownReadingPoint(
        dom.window.document.body,
        document,
        "source" in sample ? sample.source! : sample.text.indexOf(sample.target),
      ),
    ).toBe(123)
    expect(glyph).toBe(sample.glyph)
  },
)

test("authored fallback slots cannot acquire host-owned text provenance", async () => {
  const document = await parseMarkdownDocument(
    createMarkdownParser(),
    '<pre data-slot="markdown-render-fallback"><code>TARGET</code></pre>',
  )
  expect(document.reading!.runs[0].spans).toBeUndefined()
  expect(document.reading!.runs[0].source).toEqual({ start: 0, end: 67 })
})

test("raw fallback uses the same bounded reading ownership through CRLF and Unicode", () => {
  const markdown = "prefix\r\n".repeat(3000) + "reading 👩‍🔬 tail"
  const document = createMarkdownFallbackDocument(markdown)
  const dom = new JSDOM(document.blocks.map((block) => block.html).join(""))
  let glyph: string | undefined
  dom.window.Range.prototype.getBoundingClientRect = function () {
    glyph = this.toString()
    return { top: 123 } as DOMRect
  }
  expect(markdownReadingPoint(dom.window.document.body, document, markdown.indexOf("reading"))).toBe(123)
  expect(glyph).toBe("r")
  expect(dom.window.document.body.textContent).toBe(markdown.replaceAll("\r\n", "\n"))
})

test.each(["", "> "])(
  "continuation headers remain presentation without repeated reading ownership (%s)",
  async (prefix) => {
    const source =
      "| `Header` ![icon](https://example.com/icon.png) $x$ | Value |\n|---|---|\n" +
      Array.from({ length: 40 }, (_, index) => `| row ${index} | value |`).join("\n")
    const document = await parseMarkdownDocument(
      createMarkdownParser(),
      source
        .split("\n")
        .map((line) => prefix + line)
        .join("\n"),
    )
    expect(document.blocks.length).toBeGreaterThan(1)
    for (const block of document.blocks.slice(1)) {
      const dom = new JSDOM(block.html)
      expect(dom.window.document.querySelectorAll("thead [data-markdown-reading]").length).toBe(0)
      expect(dom.window.document.querySelectorAll("tbody [data-markdown-reading]").length).toBeGreaterThan(0)
    }
  },
)

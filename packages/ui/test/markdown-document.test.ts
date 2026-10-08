import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createMarkdownParser } from "../src/context/markdown-parser"
import { parseMarkdownDocument } from "../src/context/markdown-document"
import { getGeneratedKatexSource } from "../src/context/marked-math"

test.each([
  ["ZWJ emoji", 8190, "👩‍🔬"],
  ["regional indicator", 8190, "🇨🇳"],
  ["accent", 8191, "é"],
  ["indivisible large grapheme", 2, "a" + "́".repeat(9000)],
])("block splitting retains %s", async (_label, prefix, grapheme) => {
  const markdown = "x".repeat(prefix) + grapheme + "y".repeat(20_000)
  const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
  const body = new JSDOM(document.blocks.map((block) => block.html).join("")).window.document.body
  expect(body.textContent!.includes(grapheme)).toBe(true)
})

test("one admitted inline image remains atomic when its alt text crosses a chunk boundary", async () => {
  const alt = "x".repeat(13_000)
  const document = await parseMarkdownDocument(createMarkdownParser(), `![${alt}](https://example.com/image.png)`)
  const images = new JSDOM(document.blocks.map((block) => block.html).join("")).window.document.querySelectorAll("img")
  expect(images).toHaveLength(1)
  expect(images[0].alt).toBe(alt)
})

test("oversized indivisible inline metadata follows the existing source-preserving construct budget", async () => {
  const markdown = "[" + "x".repeat(20_000) + "](https://example.com/" + "a".repeat(60_000) + ")"
  const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
  expect(Math.max(...document.blocks.map((block) => block.html.length))).toBeLessThan(17_000)
  expect(document.blocks.reduce((length, block) => length + block.html.length, 0)).toBeLessThan(markdown.length + 2000)
  expect(new JSDOM(document.blocks.map((block) => block.html).join("")).window.document.body.textContent).toBe(markdown)
})

test("split inline code blocks begin at their original consumed content offsets", async () => {
  const markdown = "` " + "content ".repeat(8192) + " `\n"
  const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
  expect(document.blocks.length).toBeGreaterThan(1)
  expect(document.blocks[1].source.start).toBe(2 + 16 * 1024)
})

test.each([
  "- item\n\tcontinuation\n",
  "1. first\n\tsecond\n",
  "-\tfirst\n\tsecond\n",
  "- one\n\n\t> quoted\n\t> second\n",
  "- one\n\n\t```js\n\tcode\n\t```\n",
  "> first\n> \tsecond\n",
  "> first\n  \tsecond\n",
])("list indentation normalization preserves document source bounds: %s", async (markdown) => {
  const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
  expect(document.blocks.length).toBeGreaterThan(0)
  for (const block of document.blocks) {
    expect(block.source.start).toBeGreaterThanOrEqual(0)
    expect(block.source.end).toBeLessThanOrEqual(markdown.length)
    expect(block.source.end).toBeGreaterThan(block.source.start)
  }
  const terminal = new JSDOM(await createMarkdownParser().parse(markdown))
  const blocked = new JSDOM(document.blocks.map((block) => block.html).join(""))
  expect(blocked.window.document.body.textContent).toBe(terminal.window.document.body.textContent)
})

test("a huge Markdown message becomes bounded blocks without losing reference links, math, or code sources", async () => {
  const code = "const original = '保持原文';\n".repeat(1200)
  const markdown =
    Array.from({ length: 2000 }, (_, index) => `paragraph ${index} **bold** [reference][target]\n\n`).join("") +
    `\n$E=mc^2$\n\n\`\`\`ts\n${code}\`\`\`\n\n[target]: https://example.com "target"`
  const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
  expect(document.blocks.length).toBeGreaterThan(100)
  expect(Math.max(...document.blocks.map((block) => block.html.length))).toBeLessThan(40_000)
  const dom = new JSDOM(document.blocks.map((block) => block.html).join(""))
  expect(dom.window.document.querySelectorAll("a")).toHaveLength(2000)
  expect(dom.window.document.querySelector("a")?.href).toBe("https://example.com/")
  expect(dom.window.document.querySelectorAll("strong")).toHaveLength(2000)
  expect(dom.window.document.body.textContent).toContain("paragraph 1999")
  expect(Object.values(document.codes)).toEqual([code.trimEnd()])
  expect(getGeneratedKatexSource(dom.window.document.querySelector(".katex")!)).toBe("E=mc^2")
}, 20_000)

test("document blocks retain ordered source ranges through repeated prose and reference definitions", async () => {
  const markdown = "[reference]: https://example.com\n\n" + "Repeated [prose][reference].\n\n".repeat(90)
  const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
  let previousEnd = 0
  for (const block of document.blocks) {
    expect(block.source.start).toBeGreaterThanOrEqual(previousEnd)
    expect(block.source.end).toBeGreaterThan(block.source.start)
    expect(block.source.end).toBeLessThanOrEqual(markdown.length)
    expect(markdown.slice(block.source.start, block.source.end)).toContain("Repeated [prose][reference].")
    previousEnd = block.source.end
  }
  const source = markdown.indexOf("Repeated", markdown.indexOf("Repeated") + 1)
  expect(document.blocks.filter((block) => block.source.start <= source && source < block.source.end)).toHaveLength(1)
})

test("expanded paragraph blocks use disjoint original source ranges", async () => {
  const markdown = `**${"连续内容".repeat(12_000)}**\n\n`
  const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
  expect(document.blocks.length).toBeGreaterThan(1)
  for (let index = 1; index < document.blocks.length; index++)
    expect(document.blocks[index].source.start).toBeGreaterThanOrEqual(document.blocks[index - 1].source.end)
  expect(document.blocks.at(-1)!.source.end).toBeGreaterThan(markdown.length - 8)
})

test("table math preparation retains original source boundaries", async () => {
  const markdown = "|formula|value|\n|---|---|\n" + "|$a|b$|value|\n".repeat(40) + "\nAfter table."
  const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
  const final = document.blocks.at(-1)!
  expect(final.source.start).toBe(markdown.indexOf("After table."))
  expect(final.source.end).toBe(markdown.length)
  for (const block of document.blocks) expect(block.source.end).toBeLessThanOrEqual(markdown.length)
})

test("huge paragraphs, lists and tables keep their final content in separate blocks", async () => {
  const markdown = `**${"持续正文".repeat(10_000)}末尾正文**\n\n${Array.from({ length: 1000 }, (_, index) => `- list ${index}`).join("\n")}\n\n|head|value|\n|---|---|\n${Array.from({ length: 1000 }, (_, index) => `|${index}|行内容|`).join("\n")}`
  const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
  const dom = new JSDOM(document.blocks.map((block) => block.html).join(""))
  expect(dom.window.document.body.textContent).toContain("末尾正文")
  expect(dom.window.document.querySelectorAll("li")).toHaveLength(1000)
  expect(dom.window.document.querySelectorAll("tbody tr")).toHaveLength(1000)
  expect(document.blocks.length).toBeGreaterThan(100)
})

test("one huge nested list item or table cell cannot bypass the block budget", async () => {
  for (const markdown of [
    "- " + "deep **nested** ".repeat(12_000) + "列表末尾",
    "|head|\n|---|\n|" + "**cell** ".repeat(12_000) + "单元末尾|",
  ]) {
    expect(markdown.length).toBeGreaterThan(100_000)
    const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
    expect(document.blocks.length).toBeGreaterThan(1)
    expect(Math.max(...document.blocks.map((block) => block.html.length))).toBeLessThan(100_000)
    expect(new JSDOM(document.blocks.map((block) => block.html).join("")).window.document.body.textContent).toContain(
      markdown.includes("列表末尾") ? "列表末尾" : "单元末尾",
    )
  }
}, 20_000)

test("split code content cannot bind to an identical fence language", async () => {
  const document = await parseMarkdownDocument(createMarkdownParser(), "```txt\n" + "txt\n".repeat(5000) + "```")
  expect(document.blocks[0].source.start).toBe(7)
  expect(document.reading!.runs[0].spans![0].source).toBe(7)
})

test("nested table rows consume their original quote and list owners", async () => {
  for (const markdown of [
    "> | Head | Value |\n> |---|---|\n> | left \\| right | final |\n",
    "- item\n\n  | Head | Value |\n  |---|---|\n  | left \\| right | final |\n",
  ]) {
    const document = await parseMarkdownDocument(createMarkdownParser(), markdown)
    expect(document.blocks.map((block) => block.html).join("")).toContain("left | right")
  }
})

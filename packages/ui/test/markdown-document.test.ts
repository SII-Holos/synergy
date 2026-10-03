import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createMarkdownParser } from "../src/context/markdown-parser"
import { parseMarkdownDocument } from "../src/context/markdown-document"
import { getGeneratedKatexSource } from "../src/context/marked-math"

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

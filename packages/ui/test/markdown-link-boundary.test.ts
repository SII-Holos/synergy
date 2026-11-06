import { afterAll, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createMarkdownParser } from "../src/context/markdown-parser"
import { parseMarkdownDocument } from "../src/context/markdown-document"
import { renderUserMarkdown } from "../src/components/user-markdown-model"
import { createMarkdownStreamController } from "../src/components/markdown-stream"

const github =
  "https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/compaction/compaction-basic/src/index.ts#L289-L327"
const punctuation = "，。；！？、：“”‘’「」『』《》【】（）"
const parser = createMarkdownParser()
const dom = new JSDOM("<!doctype html><body></body>")
afterAll(() => {
  parser.dispose()
  dom.window.close()
})

for (const mode of ["user", "settled", "document"] as const) {
  const render = async (source: string) => {
    const html =
      mode === "user"
        ? await renderUserMarkdown(source, [])
        : mode === "settled"
          ? await parser.parse(source)
          : (await parseMarkdownDocument(parser, source)).blocks.map((block) => block.html).join("")
    const root = dom.window.document.createElement("div")
    root.innerHTML = html
    return root
  }
  test(`${mode} ends bare URLs at Chinese punctuation and re-parses the remaining inline content`, async () => {
    for (const boundary of punctuation) {
      const source = `😀 ${github}${boundary}理论上来讲 **后文** https://example.org/中文?q=查询#详情。结束`
      const root = await render(source)
      expect([...root.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
        github,
        "https://example.org/中文?q=查询#详情",
      ])
      expect(root.querySelector("a")?.textContent).toBe(github)
      expect(root.querySelector("strong")?.textContent).toBe("后文")
      expect(root.textContent).toContain(`${boundary}理论上来讲 后文`)
    }
  })
  test(`${mode} retains explicit targets, Chinese paths, percent encoding and balanced ASCII punctuation`, async () => {
    const explicit = "https://example.org/中文，目标。路径?q=查询"
    const root = await render(
      `[Original label](${explicit}) [Reference][ref] <${explicit}>\n\nwww.example.org/中文，www.other.org/a_(b)。\n\nhttps://example.org/%E4%B8%AD?q=a,b&x=1#part\n\n[ref]: ${explicit}`,
    )
    expect([...root.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      explicit,
      explicit,
      explicit,
      "http://www.example.org/中文",
      "http://www.other.org/a_(b)",
      "https://example.org/%E4%B8%AD?q=a,b&x=1#part",
    ])
    expect(root.querySelector("a")?.textContent).toBe("Original label")
  })
  test(`${mode} re-parses rich inline remainder without altering its explicit Chinese target`, async () => {
    const root = await render(
      "https://example.org/a，后文[Original](https://example.com/中文，路径)。 https://example.org/b，**bold**",
    )
    expect([...root.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://example.org/a",
      "https://example.com/中文，路径",
      "https://example.org/b",
    ])
    expect(root.querySelector("strong")?.textContent).toBe("bold")
    expect(root.querySelectorAll("a")[1].textContent).toBe("Original")
  })
}

test("large-document link source runs stop before punctuation and preserve original UTF-16 offsets", async () => {
  const prefix = "prefix 😀 text\r\n\r\n".repeat(2000)
  const source = `${prefix}${github}，理论上来讲 https://example.org/中文。结束`
  const document = await parseMarkdownDocument(parser, source)
  const root = dom.window.document.createElement("div")
  root.innerHTML = document.blocks.map((block) => block.html).join("")
  const first = root.querySelector("a")!
  expect(first.getAttribute("href")).toBe(github)
  const owner = first.querySelector<HTMLElement>("[data-markdown-reading]")!
  const run = document.reading!.runs[Number(owner.dataset.markdownReading!.split(":").at(-1))]
  expect(run.source).toEqual({ start: prefix.length, end: prefix.length + github.length })
  expect(source.slice(run.source.start, run.source.end)).toBe(github)
})

test("stream chunks retain Chinese boundaries, following links and exact text provenance at every split", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document })
  try {
    const source = `😀 ${github}，理论上来讲 **后文** https://example.org/中文?q=查询。结束\n`
    for (let split = 1; split < source.length; split++) {
      const root = dom.window.document.createElement("div")
      const stream = createMarkdownStreamController(root)
      stream.update(source.slice(0, split))
      stream.update(source)
      stream.end()
      expect([...root.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
        github,
        "https://example.org/中文?q=查询",
      ])
      expect(root.querySelector("strong")?.textContent).toBe("后文")
      const walker = dom.window.document.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        for (let offset = 0; offset < node.length; offset++) {
          const consumed = stream.sourceAt(node, offset)
          if (consumed !== undefined) expect(source[consumed]).toBe(node.data[offset])
        }
      }
      expect(stream.sourceAt(root.querySelector("a")!.firstChild as Text, 0)).toBe(3)
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous)
    else Reflect.deleteProperty(globalThis, "document")
  }
})

test("stream preserves explicit angle targets and recognizes www paths without swallowing Chinese boundaries", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document })
  try {
    const explicit = "https://example.org/中文，目标。路径?q=查询"
    const source = `[Original label](${explicit}) <${explicit}> www.example.org/中文，www.other.org/a_(b)。结束\n`
    for (let split = 1; split < source.length; split++) {
      const root = dom.window.document.createElement("div")
      const stream = createMarkdownStreamController(root)
      stream.update(source.slice(0, split))
      stream.update(source)
      stream.end()
      expect([...root.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
        explicit,
        explicit,
        "http://www.example.org/中文",
        "http://www.other.org/a_(b)",
      ])
      expect(root.querySelector("a")?.textContent).toBe("Original label")
      const walker = dom.window.document.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        for (let offset = 0; offset < node.length; offset++) {
          const consumed = stream.sourceAt(node, offset)
          if (consumed !== undefined) expect(source[consumed]).toBe(node.data[offset])
        }
      }
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous)
    else Reflect.deleteProperty(globalThis, "document")
  }
})

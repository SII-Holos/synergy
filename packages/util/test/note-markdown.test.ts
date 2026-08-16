import { describe, expect, test } from "bun:test"
import { NoteMarkdown } from "../src/note-markdown"

describe("NoteMarkdown.fromMarkdown", () => {
  test("parses a plain paragraph", () => {
    expect(NoteMarkdown.fromMarkdown("hello world")).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
    })
  })

  test("parses inline mark: bold, italic, code, strike, links, images, math, and hard breaks", () => {
    const doc = NoteMarkdown.fromMarkdown(
      "**bold** *italic* `code` ~~gone~~ [link](https://x) $e=mc^2$ first\nsecond ![alt](https://img)",
    )
    const paragraph = doc.content?.[0]
    expect(paragraph?.type).toBe("paragraph")
    expect(paragraph?.content).toEqual([
      { type: "text", text: "bold", marks: [{ type: "bold" }] },
      { type: "text", text: " " },
      { type: "text", text: "italic", marks: [{ type: "italic" }] },
      { type: "text", text: " " },
      { type: "text", text: "code", marks: [{ type: "code" }] },
      { type: "text", text: " " },
      { type: "text", text: "gone", marks: [{ type: "strike" }] },
      { type: "text", text: " " },
      { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x" } }] },
      { type: "text", text: " " },
      { type: "inlineMath", attrs: { latex: "e=mc^2", evaluate: "no", display: "no" } },
      { type: "text", text: " first" },
      { type: "hardBreak" },
      { type: "text", text: "second " },
      { type: "image", attrs: { src: "https://img", alt: "alt" } },
    ])
  })

  test("parses headings at every level", () => {
    const doc = NoteMarkdown.fromMarkdown("# one\n\n## two\n\n###### six")
    expect(doc.content?.map((node) => node.attrs?.level)).toEqual([1, 2, 6])
  })

  test("parses bullet, ordered, and task lists", () => {
    const doc = NoteMarkdown.fromMarkdown("- alpha\n- beta\n\n1. first\n2. second\n\n- [ ] open\n- [x] done")
    const [bullet, ordered, task] = doc.content ?? []
    expect(bullet?.type).toBe("bulletList")
    expect(bullet?.content?.map((item) => item.content?.[0]?.content?.[0]?.text)).toEqual(["alpha", "beta"])
    expect(ordered?.type).toBe("orderedList")
    expect(ordered?.content?.map((item) => item.content?.[0]?.content?.[0]?.text)).toEqual(["first", "second"])
    expect(task?.type).toBe("taskList")
    expect(task?.content?.map((item) => item.attrs?.checked)).toEqual([false, true])
  })

  test("parses fenced code blocks with a language", () => {
    const doc = NoteMarkdown.fromMarkdown("```ts\nconst x = 1\n```")
    expect(doc.content).toEqual([
      { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const x = 1" }] },
    ])
  })

  test("parses blockquotes, horizontal rules, block math, and images", () => {
    const doc = NoteMarkdown.fromMarkdown("> quoted\n\n---\n\n$$\nx + y\n$$\n\n![pic](https://pic)")
    expect(doc.content?.map((node) => node.type)).toEqual(["blockquote", "horizontalRule", "paragraph", "image"])
    expect(doc.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("quoted")
    expect(doc.content?.[2]?.content?.[0]?.attrs).toEqual({ latex: "x + y", evaluate: "no", display: "yes" })
  })

  test("parses tables with headers and cells", () => {
    const doc = NoteMarkdown.fromMarkdown("| Name | Value |\n| --- | --- |\n| a | 1 |")
    expect(doc.content).toEqual([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] },
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
            ],
          },
        ],
      },
    ])
  })

  test("parses multi-line paragraphs and skips blank lines", () => {
    expect(NoteMarkdown.fromMarkdown("line one\nline two\n\nline three")).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "line one" }, { type: "hardBreak" }, { type: "text", text: "line two" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "line three" }] },
      ],
    })
  })

  test("returns an empty paragraph doc for empty input", () => {
    expect(NoteMarkdown.fromMarkdown("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
  })
})

describe("NoteMarkdown.toMarkdown", () => {
  test("renders inline marks and breaks", () => {
    expect(
      NoteMarkdown.toMarkdown({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "b", marks: [{ type: "bold" }] },
              { type: "text", text: "i", marks: [{ type: "italic" }] },
              { type: "text", text: "c", marks: [{ type: "code" }] },
              { type: "text", text: "s", marks: [{ type: "strike" }] },
              { type: "text", text: "l", marks: [{ type: "link", attrs: { href: "https://x" } }] },
              { type: "hardBreak" },
              { type: "text", text: "next" },
            ],
          },
        ],
      }),
    ).toBe("**b***i*`c`~~s~~[l](https://x)\nnext")
  })

  test("renders headings, lists, and task lists", () => {
    expect(
      NoteMarkdown.toMarkdown({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Title" }] },
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }],
          },
          {
            type: "orderedList",
            content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] }],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: true },
                content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
              },
            ],
          },
        ],
      }),
    ).toBe("### Title\n\n- a\n\n1. b\n\n- [x] c")
  })

  test("renders code blocks, blockquotes, rules, images, and block math", () => {
    expect(
      NoteMarkdown.toMarkdown({
        type: "doc",
        content: [
          { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const x = 1" }] },
          { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
          { type: "horizontalRule" },
          { type: "image", attrs: { src: "https://img", alt: "alt" } },
          {
            type: "paragraph",
            content: [{ type: "inlineMath", attrs: { latex: "x", display: "yes" } }],
          },
        ],
      }),
    ).toBe("```ts\nconst x = 1\n```\n\n> quoted\n\n---\n\n![alt](https://img)\n\n$$\nx\n$$")
  })

  test("renders tables with padded columns", () => {
    expect(
      NoteMarkdown.toMarkdown({
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
                  { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "long" }] }] },
                ],
              },
              {
                type: "tableRow",
                content: [
                  { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("| a   | long |\n| --- | ---- |\n| b   |      |")
  })

  test("renders unknown containers through their children", () => {
    expect(
      NoteMarkdown.toMarkdown({
        type: "doc",
        content: [
          { type: "customContainer", content: [{ type: "paragraph", content: [{ type: "text", text: "inside" }] }] },
        ],
      }),
    ).toBe("inside")
  })

  test("returns empty strings for empty or non-object input", () => {
    expect(NoteMarkdown.toMarkdown(null)).toBe("")
    expect(NoteMarkdown.toMarkdown(undefined)).toBe("")
    expect(NoteMarkdown.toMarkdown("text")).toBe("")
  })
})

describe("NoteMarkdown.toPreviewHtml", () => {
  test("renders escaped text with inline marks", () => {
    expect(
      NoteMarkdown.toPreviewHtml({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "<b> & " },
              { type: "text", text: "bold", marks: [{ type: "bold" }] },
              { type: "text", text: "i", marks: [{ type: "italic" }] },
              { type: "text", text: "c", marks: [{ type: "code" }] },
              { type: "text", text: "s", marks: [{ type: "strike" }] },
              { type: "text", text: "l", marks: [{ type: "link", attrs: { href: "https://x" } }] },
            ],
          },
        ],
      }),
    ).toBe(
      '<p>&lt;b&gt; &amp; <strong>bold</strong><em>i</em><code>c</code><s>s</s><span class="note-preview-link">l</span></p>',
    )
  })

  test("renders headings, lists, tasks, and quotes", () => {
    expect(
      NoteMarkdown.toPreviewHtml({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }],
          },
          {
            type: "orderedList",
            content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] }],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: true },
                content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
              },
            ],
          },
          { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
          { type: "horizontalRule" },
        ],
      }),
    ).toBe(
      '<h2>Title</h2><ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol><ul class="note-preview-task-list"><li><input type="checkbox" checked disabled><p>c</p></li></ul><blockquote><p>quoted</p></blockquote><hr>',
    )
  })

  test("truncates long code blocks and renders diagram/video placeholders", () => {
    expect(
      NoteMarkdown.toPreviewHtml({
        type: "doc",
        content: [
          { type: "codeBlock", content: [{ type: "text", text: "1\n2\n3\n4\n5\n6" }] },
          { type: "video" },
          { type: "mermaid", attrs: { content: "graph TD;\nA" } },
        ],
      }),
    ).toBe(
      '<pre><code>1\n2\n3\n4\n…</code></pre><div class="note-preview-media-placeholder"><span>Video</span></div><div class="note-preview-diagram"><span>Diagram</span><code>graph TD;</code></div>',
    )
  })

  test("renders only trusted image sources and falls back to placeholders", () => {
    expect(
      NoteMarkdown.toPreviewHtml({
        type: "doc",
        content: [
          { type: "image", attrs: { src: "/asset/img.png", alt: "trusted" } },
          { type: "image", attrs: { src: "https://host/assets/img.png" } },
          { type: "image", attrs: { src: "data:image/png;base64,AAAA", alt: "inline" } },
          { type: "image", attrs: { src: "javascript:alert(1)", alt: "unsafe" } },
          { type: "image", attrs: { src: "https://evil.example/x.png", alt: "external" } },
          {
            type: "paragraph",
            content: [{ type: "image", attrs: { src: "/asset/small.png" } }],
          },
          {
            type: "paragraph",
            content: [{ type: "image", attrs: { src: "https://evil.example/y.png", alt: "inline unsafe" } }],
          },
        ],
      }),
    ).toBe(
      '<figure class="note-preview-figure"><img src="/asset/img.png" alt="trusted" loading="lazy" decoding="async"><figcaption>trusted</figcaption></figure>' +
        '<figure class="note-preview-figure"><img src="https://host/assets/img.png" alt="" loading="lazy" decoding="async"></figure>' +
        '<figure class="note-preview-figure"><img src="data:image/png;base64,AAAA" alt="inline" loading="lazy" decoding="async"><figcaption>inline</figcaption></figure>' +
        '<div class="note-preview-media-placeholder"><span>Image</span><small>unsafe</small></div>' +
        '<div class="note-preview-media-placeholder"><span>Image</span><small>external</small></div>' +
        '<p><span class="note-preview-image-inline"><img src="/asset/small.png" alt="" loading="lazy" decoding="async"></span></p>' +
        '<p><span class="note-preview-media-chip">Image</span></p>',
    )
  })

  test("renders inline math and skips the title-matching first block", () => {
    expect(
      NoteMarkdown.toPreviewHtml(
        {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "My Note" }] },
            { type: "paragraph", content: [{ type: "inlineMath", attrs: { latex: "a<b", display: "no" } }] },
            { type: "paragraph", content: [{ type: "inlineMath", attrs: { latex: "x", display: "yes" } }] },
            { type: "paragraph", content: [{ type: "hardBreak" }] },
          ],
        },
        { title: "My Note" },
      ),
    ).toBe(
      '<p><span class="note-preview-math">$a&lt;b$</span></p><p><span class="note-preview-math note-preview-math--display">$$x$$</span></p><p><br></p>',
    )
  })

  test("renders tables with row and cell caps", () => {
    const row = (label: string) => ({
      type: "tableRow",
      content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: label }] }] }],
    })
    expect(
      NoteMarkdown.toPreviewHtml({
        type: "doc",
        content: [
          {
            type: "table",
            content: [row("h1"), row("1"), row("2"), row("3"), row("4"), row("5")],
          },
        ],
      }),
    ).toBe(
      '<div class="note-preview-table-wrap"><table><tr><td>h1</td></tr><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></table><div class="note-preview-table-more">+2 rows</div></div>',
    )
  })

  test("respects maxBlocks and returns empty for non-doc input", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
        { type: "paragraph", content: [{ type: "text", text: "three" }] },
      ],
    }
    expect(NoteMarkdown.toPreviewHtml(doc, { maxBlocks: 2 })).toBe("<p>one</p><p>two</p>")
    expect(NoteMarkdown.toPreviewHtml({ type: "paragraph", content: [] })).toBe("")
    expect(NoteMarkdown.toPreviewHtml(null)).toBe("")
  })
})

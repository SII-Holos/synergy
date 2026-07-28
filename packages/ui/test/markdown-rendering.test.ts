import { describe, expect, test } from "bun:test"
import {
  escapeMarkdownFallbackHtml,
  isCurrentMarkdownRender,
  markdownFallbackHtml,
  markdownRenderEntry,
} from "../src/components/markdown-render"
import { createTextPartProjection, isTextPartTerminal } from "../src/components/text-part-render"

describe("Markdown terminal rendering", () => {
  test("ignores stale rendered HTML whose hash does not match current markdown", () => {
    const prefix = "intro only"
    const full = `intro\n\n\`\`\`markdown\n${"body\n".repeat(20)}\`\`\``

    expect(isCurrentMarkdownRender(markdownRenderEntry(prefix, "<p>intro only</p>"), full)).toBe(false)
    expect(isCurrentMarkdownRender(markdownRenderEntry(full, "<p>full</p>"), full)).toBe(true)
  })

  test("escapes markdown render fallback HTML", () => {
    const html = markdownFallbackHtml('<img src=x onerror="alert(1)"> & text')

    expect(html).toContain('data-slot="markdown-render-fallback"')
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; text")
    expect(html).not.toContain('<img src=x onerror="alert(1)">')
  })

  test("escapes apostrophes in fallback HTML", () => {
    expect(escapeMarkdownFallbackHtml("it's fine")).toBe("it&#39;s fine")
  })
})

describe("createTextPartProjection", () => {
  test("processes appended text without exposing trim whitespace", () => {
    const projection = createTextPartProjection()

    expect(projection.project({ key: "part_1", source: "  hello  ", completed: false })).toBe("hello")
    expect(projection.project({ key: "part_1", source: "  hello  \nworld", completed: false })).toBe("hello  \nworld")
  })

  test("relativizes a project path split across stream updates", () => {
    const projection = createTextPartProjection()
    const remove = "/workspace/project"

    expect(projection.project({ key: "part_1", source: "  /workspace/pro", completed: false, remove })).toBe("")
    expect(
      projection.project({
        key: "part_1",
        source: "  /workspace/project/src/index.ts",
        completed: false,
        remove,
      }),
    ).toBe("/src/index.ts")
  })

  test("keeps the project root visible inside inline code", () => {
    const projection = createTextPartProjection()
    const source = "我当前的工作目录是：\n\n`/workspace/project`"
    const expected = "我当前的工作目录是：\n\n`.`"

    expect(projection.project({ key: "part_1", source, completed: false, remove: "/workspace/project" })).toBe(expected)
    expect(projection.project({ key: "part_1", source, completed: true, remove: "/workspace/project" })).toBe(expected)
  })

  test("does not relativize a matching prefix inside ordinary text", () => {
    const projection = createTextPartProjection()
    const source = "Package: `/workspace/projectile`"

    expect(projection.project({ key: "part_1", source, completed: false, remove: "/workspace/project" })).toBe(source)
    expect(projection.project({ key: "part_1", source, completed: true, remove: "/workspace/project" })).toBe(source)
  })

  test("rebuilds once for terminal or rewritten source", () => {
    const projection = createTextPartProjection()
    const remove = "/workspace/project"

    expect(projection.project({ key: "part_1", source: "  /workspace/pro", completed: false, remove })).toBe("")
    expect(projection.project({ key: "part_1", source: "  /workspace/pro", completed: true, remove })).toBe(
      "/workspace/pro",
    )
    expect(projection.project({ key: "part_2", source: "  replacement  ", completed: false, remove })).toBe(
      "replacement",
    )
  })
})

describe("isTextPartTerminal", () => {
  test("keeps an unfinished part on the streaming renderer until its own lifecycle ends", () => {
    expect(isTextPartTerminal({ partEnd: undefined, messageCompleted: undefined })).toBe(false)
    expect(isTextPartTerminal({ partEnd: 2, messageCompleted: undefined })).toBe(true)
    expect(isTextPartTerminal({ partEnd: undefined, messageCompleted: 3 })).toBe(true)
  })
})

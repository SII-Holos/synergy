import { describe, expect, test } from "bun:test"
import {
  escapeMarkdownFallbackHtml,
  isCurrentMarkdownRender,
  markdownFallbackHtml,
  markdownRenderEntry,
} from "../src/components/markdown-render"
import { createTextPartProjection } from "../src/components/text-part-render"

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

  test("removes a project path split across stream updates", () => {
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

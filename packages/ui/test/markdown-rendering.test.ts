import { describe, expect, test } from "bun:test"
import {
  escapeMarkdownFallbackHtml,
  isCurrentMarkdownRender,
  markdownFallbackHtml,
  markdownRenderEntry,
} from "../src/components/markdown-render"
import { renderableTextPartMarkdownText } from "../src/components/text-part-render"

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

describe("renderableTextPartMarkdownText", () => {
  test("uses full source once completion arrives instead of typewriter prefix", () => {
    expect(
      renderableTextPartMarkdownText({
        completed: true,
        source: "intro\n\n```markdown\nfull long block\n```",
        typed: "intro",
      }),
    ).toBe("intro\n\n```markdown\nfull long block\n```")
  })

  test("uses typewriter text while still streaming", () => {
    expect(
      renderableTextPartMarkdownText({
        completed: false,
        source: "complete source",
        typed: "visible prefix",
      }),
    ).toBe("visible prefix")
  })
})

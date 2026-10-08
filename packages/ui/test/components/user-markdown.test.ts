import { describe, expect, test } from "bun:test"
import { renderUserMarkdown } from "../../src/components/user-markdown-model"

describe("user Markdown", () => {
  test("a workspace file written with image syntax remains a button without a broken image", async () => {
    const html = await renderUserMarkdown("![Readme](README.md)", [])
    expect(html).toContain('data-user-image="README.md"')
    expect(html).toContain("Readme</button>")
    expect(html).not.toContain("<img")
  })
  test("keeps inline images as explicit preview actions", async () => {
    for (const url of ["data:image/png;base64,AAAA", "blob:https://ui.example/image"])
      expect(await renderUserMarkdown(`![Chart](${url})`, [])).toContain(`data-user-image="${url}"`)
    expect(await renderUserMarkdown("![Unsafe](data:text/html,unsafe)", [])).not.toContain("data-user-image")
  })
  test("routes explicit file links through resource references and leaves code literal", async () => {
    const html = await renderUserMarkdown(
      "[源码](src/main.ts#L3-L7) [网页](https://example.com) `src/main.ts`\n\n[文件][file]\n\n[file]: docs/a%20b.md#intro",
      [],
    )
    expect(html).toContain('data-resource-reference="src/main.ts#L3-L7"')
    expect(html).toContain('data-resource-reference="docs/a%20b.md#intro"')
    expect(html).not.toContain('href="src/')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain("<code>src/main.ts</code>")
  })
  test("renders one structured document and preserves authoritative UTF-16 references", async () => {
    const source = "# 中文 😀\n\n**打开 src/main.ts**\n\n| A | B |\n| - | - |\n| 1 | 2 |"
    const start = source.indexOf("src/main.ts")
    const html = await renderUserMarkdown(source, [{ start, end: start + 11 }])
    expect(html).toContain("<h1>中文 😀</h1>")
    expect(html).toContain("<strong>打开 <button")
    expect(html).toContain('data-user-reference="0"')
    expect(html).toContain("<table>")
  })

  test("keeps escaped source positions, ignores invalid ranges and does not infer file paths", async () => {
    const source = "a &amp; 😀 src/main.ts and /some/file.ts"
    const start = source.indexOf("src/main.ts")
    const html = await renderUserMarkdown(source, [
      { start, end: start + 11 },
      { start: -1, end: 4 },
    ])
    expect(html).toContain("a &#x26; 😀")
    expect(html.match(/data-user-reference=/g)).toHaveLength(1)
    expect(html).toContain("and /some/file.ts")
  })

  test("displays HTML literally and never loads Markdown images", async () => {
    const html = await renderUserMarkdown(
      '<img src=x onerror="alert(1)">\n\n![截图](https://example.com/image.png)',
      [],
    )
    expect(html).not.toContain("<img")
    expect(html).toContain("&#x3C;img")
    expect(html).toContain('data-user-image="https://example.com/image.png"')
    expect(await renderUserMarkdown("![x](javascript:alert%281%29)", [])).not.toContain("data-user-image")
    const referenceImage = await renderUserMarkdown("![截图][image]\n\n[image]: https://example.com/image.png", [])
    expect(referenceImage).not.toContain("<img")
    expect(referenceImage).toContain('data-user-image="https://example.com/image.png"')
  })

  test("code and formula blocks use the existing renderer without interpreting references", async () => {
    const source = "`src/main.ts`\n\n```ts\nconst a = 1\n```\n\n$$x^2$$"
    const calls: string[] = []
    const html = await renderUserMarkdown(source, [{ start: 1, end: 12 }], async (raw) => {
      calls.push(raw)
      return "<pre>highlighted</pre>"
    })
    expect(html).not.toContain("data-user-reference")
    expect(calls).toHaveLength(2)
    expect(html).toContain("highlighted")
  })
})

test("failed optional highlighting keeps readable source and the surrounding Markdown", async () => {
  const html = await renderUserMarkdown("# 标题\n\n```js\n<script>原文😀</script>\n```", [], async () => {
    throw new Error("highlighter unavailable")
  })
  expect(html).toContain("<h1>标题</h1>")
  expect(html).toContain("<pre><code>&#x3C;script>原文😀&#x3C;/script></code></pre>")
})

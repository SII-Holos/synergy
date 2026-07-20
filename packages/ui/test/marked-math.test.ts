import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import markedKatex from "marked-katex-extension"
import { convertLatexDelimiters } from "../src/context/marked-math"

async function render(markdown: string) {
  const parser = new Marked()
  parser.use(
    markedKatex({
      throwOnError: false,
      nonStandard: true,
    }),
  )
  return parser.parse(convertLatexDelimiters(markdown))
}

describe("Markdown math rendering", () => {
  test("renders multiline LaTeX display delimiters as a KaTeX block", async () => {
    const markdown = String.raw`\[
\sum_{t=0}^{n-1}\Delta\Phi_{\Theta,\mu}(t;X)
=
J_{\Theta,\mu}(K_0;X)
-
J_{\Theta,\mu}(K_n;X)
\]`

    const html = await render(markdown)

    expect(html).toContain('class="katex-display"')
    expect(html).toContain('annotation encoding="application/x-tex"')
    expect(html).not.toContain("$$")
  })

  test("renders standalone single-line display delimiters as a KaTeX block", async () => {
    const html = await render(String.raw`\[J_{\Theta,\mu}(K;X)\]`)

    expect(html).toContain('class="katex-display"')
    expect(html).not.toContain("$$")
  })

  test("keeps embedded display delimiters inline", async () => {
    const html = await render(String.raw`before \[J_{\Theta}(K;X)\] after`)

    expect(html).toContain('class="katex"')
    expect(html).not.toContain('class="katex-display"')
    expect(html).toContain("before")
    expect(html).toContain("after")
  })
})

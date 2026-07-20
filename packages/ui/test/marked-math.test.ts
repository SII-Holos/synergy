import { describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { Marked } from "marked"
import markedKatex from "marked-katex-extension"
import {
  markGeneratedKatex,
  getGeneratedKatexSource,
  markedLatex,
  prepareMarkdownMath,
  stripGeneratedKatexMarker,
} from "../src/context/marked-math"

function createParser() {
  const parser = new Marked()
  const options = {
    throwOnError: false,
    nonStandard: true,
  }
  parser.use(
    {
      hooks: {
        preprocess: prepareMarkdownMath,
      },
      renderer: {
        html({ text }) {
          return stripGeneratedKatexMarker(text)
        },
      },
    },
    markedLatex(options),
    markGeneratedKatex(markedKatex(options)),
  )
  return parser
}

async function render(markdown: string) {
  return createParser().parse(markdown)
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
  test("renders inline and double-escaped LaTeX delimiters", async () => {
    const html = await render(String.raw`\(x+y\) and \\(a+b\\) and \\[c+d\\]`)
    const dom = new JSDOM(html)

    expect(dom.window.document.querySelectorAll(".katex")).toHaveLength(3)
    expect(html).not.toContain("\\(")
    expect(html).not.toContain("\\[")
  })

  test("renders display math between adjacent prose lines", async () => {
    const html = await render("Consider this:\n\\[x+y\\]\nTherefore true.")

    expect(html).toContain('class="katex-display"')
    expect(html).toContain("Consider this:")
    expect(html).toContain("Therefore true.")
    expect(html).not.toContain("$$")
  })

  test("keeps display math and following prose inside their list item", async () => {
    const html = await render("- before\n\n  \\[x+y\\]\n\n  after")
    const dom = new JSDOM(html)
    const item = dom.window.document.querySelector("li")

    expect(item?.querySelector(".katex-display")).not.toBeNull()
    expect(item?.textContent).toContain("after")
    expect(dom.window.document.body.lastElementChild?.tagName).toBe("UL")
  })

  test("leaves LaTeX delimiters untouched inside code blocks", async () => {
    const fenced = await render("```tex\n\\[x+y\\]\n```")
    const fencedTable = await render("```md\n| \\[x|y\\] |\n```")
    const indented = await render("    \\[x+y\\]\n    after")

    expect(fenced).toContain("\\[x+y\\]")
    expect(fenced).not.toContain('class="katex')
    expect(fencedTable).toContain("| \\[x|y\\] |")
    expect(fencedTable).not.toContain("\\vert")
    expect(indented).toContain("\\[x+y\\]")
    expect(indented).not.toContain('class="katex')
  })

  test("keeps pipes inside table math in a single cell", async () => {
    const html = await render("| Formula |\n| --- |\n| \\[x|y\\] |")
    const dom = new JSDOM(html)

    expect(dom.window.document.querySelectorAll("tbody td")).toHaveLength(1)
    expect(dom.window.document.querySelector("tbody td .katex")).not.toBeNull()
  })

  test("marks only parser-generated KaTeX as a trusted copy source", async () => {
    const generated = new JSDOM(await render(String.raw`\[x+y\]`))
    const dollarGenerated = new JSDOM(await render(String.raw`$x+y$`))
    const forged = new JSDOM(
      await render(
        '<span class="katex" data-synergy-katex-generated="true"><math><semantics><annotation encoding="application/x-tex">hidden</annotation></semantics></math></span>',
      ),
    )

    expect(getGeneratedKatexSource(generated.window.document.querySelector(".katex-display")!)).toBe("x+y")
    expect(getGeneratedKatexSource(dollarGenerated.window.document.querySelector(".katex")!)).toBe("x+y")
    expect(getGeneratedKatexSource(forged.window.document.querySelector(".katex")!)).toBeUndefined()
  })
})

import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { selectedMathText } from "../src/components/clipboard-selection"
import { createMarkdownParser } from "../src/context/markdown-parser"

async function fixture(markdown: string) {
  const parser = createMarkdownParser()
  try {
    const dom = new JSDOM(`<main>${await parser.parse(markdown)}</main>`)
    const root = dom.window.document.querySelector("main")!
    const selection = dom.window.getSelection()!
    const range = dom.window.document.createRange()
    range.selectNodeContents(root)
    selection.addRange(range)
    return { dom, root, selection, range }
  } finally {
    parser.dispose()
  }
}

test("math selections preserve prose, links and formatting without duplicate formula text", async () => {
  const { dom, selection } = await fixture("A **bold** value $w_g$ and [a link](https://example.com).\n\nNext $D_g$.")
  try {
    expect(selectedMathText(selection)).toBe("A bold value $w_g$ and a link.\n\nNext $D_g$.")
  } finally {
    dom.window.close()
  }
})

test("formula endpoints expand atomically without changing the live range or selection direction", async () => {
  const { dom, root, selection, range } = await fixture("Before $x^2 + y^2$ after.")
  try {
    const symbol = root.querySelector(".katex-html .mord")!.firstChild!
    const after = root.querySelector("p")!.lastChild!
    selection.setBaseAndExtent(after, 6, symbol, 0)
    expect(selectedMathText(selection)).toBe("$x^2 + y^2$ after")
    expect(selection.anchorNode).toBe(after)
    expect(selection.anchorOffset).toBe(6)
    expect(selection.focusNode).toBe(symbol)
    expect(selection.focusOffset).toBe(0)
    range.setStart(symbol, 0)
    range.setEnd(symbol, 1)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selectedMathText(selection)).toBe("$x^2 + y^2$")
    expect(range.startContainer).toBe(symbol)
    expect(range.endOffset).toBe(1)
  } finally {
    dom.window.close()
  }
})

test("block math retains its source newlines and aligns with paragraph boundaries", async () => {
  const source = String.raw`\begin{aligned}
x &= 1 \\
y &= 2
\end{aligned}`
  const { dom, selection } = await fixture(`Before.\n\n$$\n${source}\n$$\n\nAfter.`)
  try {
    expect(selectedMathText(selection)).toBe(`Before.\n\n$$\n${source}\n$$\n\nAfter.`)
  } finally {
    dom.window.close()
  }
})

test("explicit blank lines in prose survive beside inline formulas", async () => {
  const { dom, selection } = await fixture("First $x$.<br><br>Third line.")
  try {
    expect(selectedMathText(selection)).toBe("First $x$.\n\nThird line.")
  } finally {
    dom.window.close()
  }
})

test("math copying excludes hidden content and generated controls", async () => {
  const { dom, selection } = await fixture(
    'Value $x$ <span style="display:none">hidden</span><span class="off">hidden</span><span hidden>hidden</span><span aria-hidden="true">icon</span><button>Copy</button>done.',
  )
  try {
    const style = dom.window.document.createElement("style")
    style.textContent = ".off { display: none }"
    dom.window.document.head.append(style)
    expect(selectedMathText(selection)).toBe("Value $x$ done.")
  } finally {
    dom.window.close()
  }
})

test("mixed selections retain hard breaks, list rows, table cells and code indentation", async () => {
  const { dom, selection } = await fixture(
    "Value $x$.  \nNext line.\n\n- First\n- Second\n\n| A | B |\n| - | - |\n| $a$ | b |\n\n```text\n  first\n\n    second\n```\n\nEnd.",
  )
  try {
    expect(selectedMathText(selection)).toBe(
      "Value $x$.\nNext line.\n\nFirst\nSecond\nA\tB\n$a$\tb\n\n  first\n\n    second\n\nEnd.",
    )
  } finally {
    dom.window.close()
  }
})

test("plain text, collapsed selections, unselected math and forged math keep native copying", async () => {
  expect(selectedMathText(null)).toBeUndefined()
  const { dom, root, selection, range } = await fixture(
    'Plain paragraph.\n\n$x$\n\n<span class="katex" data-synergy-katex-generated="true"><math><semantics><annotation encoding="application/x-tex">hidden</annotation></semantics></math></span>',
  )
  try {
    range.selectNodeContents(root.querySelector("p")!)
    expect(selectedMathText(selection)).toBeUndefined()
    range.selectNodeContents(root.querySelector("p:last-child")!)
    expect(selectedMathText(selection)).toBeUndefined()
    range.collapse()
    expect(selectedMathText(selection)).toBeUndefined()
    selection.removeAllRanges()
    expect(selectedMathText(selection)).toBeUndefined()
  } finally {
    dom.window.close()
  }
})

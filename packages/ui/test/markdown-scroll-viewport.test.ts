import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { markdownScrollViewport } from "../src/components/markdown-scroll-viewport"

function fixture() {
  const dom = new JSDOM('<div id="outer"><div id="inner"><div id="root"></div></div></div>')
  const element = (id: string) => dom.window.document.getElementById(id)!
  const size = (element: HTMLElement, client: number, scroll: number) => {
    element.style.overflowY = "auto"
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: client },
      scrollHeight: { configurable: true, value: scroll },
    })
  }
  return { outer: element("outer"), inner: element("inner"), root: element("root"), size }
}

test("a declared cold viewport remains authoritative over incidental native overflow", () => {
  const { outer, inner, root, size } = fixture()
  outer.dataset.scrollViewport = "vertical"
  size(outer, 280, 280)
  size(inner, 100, 101)
  expect(markdownScrollViewport(root)).toBe(outer)
  inner.dataset.scrollViewport = "vertical"
  expect(markdownScrollViewport(root)).toBe(inner)
})

test("undeclared ancestors require actual vertical overflow and use the closest native owner", () => {
  const { outer, inner, root, size } = fixture()
  size(outer, 280, 1000)
  size(inner, 100, 100)
  expect(markdownScrollViewport(root)).toBe(outer)
  size(inner, 100, 101)
  expect(markdownScrollViewport(root)).toBe(inner)
})

test("an undeclared content-sized scroll container leaves ownership to Window", () => {
  const { outer, inner, root, size } = fixture()
  size(outer, 280, 280)
  size(inner, 1000, 1000)
  expect(markdownScrollViewport(root)).toBeUndefined()
})

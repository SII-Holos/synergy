import { afterAll, beforeAll, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createMarkdownTerminalTransitionController } from "../src/components/markdown-terminal-transition"

let dom: JSDOM
beforeAll(() => {
  dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true })
  Object.assign(globalThis, { document: dom.window.document, window: dom.window })
})
afterAll(() => dom.window.close())

test("finishing streamed prose keeps matching content mounted and fully readable", () => {
  const container = document.createElement("div")
  container.innerHTML = "<p>Read the project files.</p>"
  const paragraph = container.firstElementChild
  const controller = createMarkdownTerminalTransitionController()
  let enhanced = 0
  controller.apply({
    container,
    hash: "first",
    html: "<p>Read the project files.</p>\n",
    enhance: () => {
      enhanced++
      return () => {
        enhanced--
      }
    },
  })
  expect(container.firstElementChild).toBe(paragraph)
  expect(container.querySelector('[data-slot="markdown-terminal-crossfade"]')).toBeNull()
  expect(container.textContent).toBe("Read the project files.")
  expect(enhanced).toBe(1)
  controller.reset()
  expect(enhanced).toBe(0)
})

test("rich final content replaces the stream atomically and sibling updates never replay it", () => {
  const container = document.createElement("div")
  container.innerHTML = "<p>Pending</p>"
  const controller = createMarkdownTerminalTransitionController()
  let enhanced = 0
  const input = {
    container,
    hash: "final",
    html: "<p><strong>Verified</strong></p>",
    enhance: () => {
      enhanced++
      return () => {
        enhanced--
      }
    },
  }
  for (let index = 0; index < 100; index++) {
    expect(controller.apply(input)).toBe(index === 0)
    expect(container.innerHTML).toBe(input.html)
    expect(container.children).toHaveLength(1)
    expect(container.querySelector("strong")?.textContent).toBe("Verified")
  }
  expect(enhanced).toBe(1)
  controller.reset()
  expect(enhanced).toBe(0)
  expect(container.textContent).toBe("Verified")
})

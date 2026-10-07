import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createMarkdownStreamController } from "../src/components/markdown-stream"

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true })

beforeAll(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: dom.window.document,
  })
})

afterAll(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument)
  else Reflect.deleteProperty(globalThis, "document")
  dom.window.close()
})

function createRoot() {
  return document.createElement("div")
}

describe("createMarkdownStreamController", () => {
  test.each([
    ["Hello 👩‍", "Hello 👩‍🔬 hello ", "👩‍🔬"],
    ["Hello 🇨🇳", "Hello 🇨🇳 hello ", "🇨🇳"],
    ["Hello é", "Hello é hello ", "é"],
  ])("a grapheme split across stream chunks stays in one text run: %s", (first, next, grapheme) => {
    const root = createRoot()
    const original = dom.window.HTMLElement.prototype.animate
    dom.window.HTMLElement.prototype.animate = () => ({ cancel() {}, onfinish: null }) as unknown as Animation
    try {
      const stream = createMarkdownStreamController(root)
      stream.update(first)
      stream.update(next)
      expect(
        [...root.querySelector("p")!.childNodes].some(
          (node) => node.nodeType === 3 && node.textContent?.includes(grapheme),
        ),
      ).toBe(true)
      stream.end()
      expect(root.textContent).toBe(next)
    } finally {
      dom.window.HTMLElement.prototype.animate = original
    }
  })

  test("fades only appended text and removes transient wrappers before terminal rendering", () => {
    const root = createRoot()
    const animated: HTMLElement[] = []
    const original = dom.window.HTMLElement.prototype.animate
    dom.window.HTMLElement.prototype.animate = function () {
      animated.push(this)
      return { cancel() {}, onfinish: null } as unknown as Animation
    }
    try {
      const stream = createMarkdownStreamController(root)
      stream.update("Existing paragraph.\n\n", "part")
      const paragraph = root.firstElementChild
      expect(animated).toHaveLength(0)
      stream.update("Existing paragraph.\n\nNew **text** arrives. ", "part")
      expect(animated.length).toBeGreaterThan(0)
      expect(animated.every((node) => !node.contains(paragraph))).toBe(true)
      expect(root.firstElementChild).toBe(paragraph)
      stream.end()
      expect(root.querySelector("span")).toBeNull()
      expect(root.textContent).toBe("Existing paragraph.New text arrives. ")
      expect(root.firstElementChild).toBe(paragraph)
    } finally {
      dom.window.HTMLElement.prototype.animate = original
    }
  })

  test("preserves existing DOM while appending a growing snapshot", () => {
    const root = createRoot()
    const stream = createMarkdownStreamController(root)

    stream.update("Hello")
    const first = root.firstElementChild
    stream.update("Hello **world**")
    stream.end()

    expect(first).toBeTruthy()
    expect(root.firstElementChild).toBe(first)
    expect(root.textContent).toBe("Hello world")
  })

  test("bounds transient nodes under a burst and preserves selected text until it is released", () => {
    const root = createRoot()
    document.body.append(root)
    const finish: (() => void)[] = []
    const original = dom.window.HTMLElement.prototype.animate
    dom.window.HTMLElement.prototype.animate = function () {
      const animation = { cancel() {}, onfinish: null as (() => void) | null }
      finish.push(() => animation.onfinish?.())
      return animation as unknown as Animation
    }
    try {
      const stream = createMarkdownStreamController(root)
      let text = "Initial "
      stream.update(text)
      for (let index = 0; index < 200; index++) stream.update((text += `片段${index} `))
      expect(root.querySelectorAll("[data-stream-arrival]").length).toBeGreaterThan(0)
      expect(root.querySelectorAll("[data-stream-arrival]").length).toBeLessThanOrEqual(32)
      const selected = root.querySelector("[data-stream-arrival]")!
      const range = document.createRange()
      range.selectNodeContents(selected)
      const selection = document.getSelection()!
      selection.addRange(range)
      const before = selection.toString()
      finish.forEach((callback) => callback())
      expect(selection.toString()).toBe(before)
      expect(selected.isConnected).toBe(true)
      selection.removeAllRanges()
      document.dispatchEvent(new dom.window.Event("selectionchange"))
      expect(root.querySelector("[data-stream-arrival]")).toBeNull()
      stream.end()
      expect(root.textContent).toBe(text)
    } finally {
      dom.window.HTMLElement.prototype.animate = original
      root.remove()
    }
  })

  test("resets from the authoritative snapshot when the source shrinks", () => {
    const root = createRoot()
    const stream = createMarkdownStreamController(root)

    stream.update("First paragraph\n\nSecond paragraph")
    const first = root.firstElementChild
    stream.update("Replacement")
    stream.end()

    expect(root.textContent).toBe("Replacement")
    expect(root.firstElementChild).not.toBe(first)
  })

  test("resets when a mounted renderer receives a different part", () => {
    const root = createRoot()
    const stream = createMarkdownStreamController(root)

    stream.update("old", "part_1")
    const first = root.firstElementChild
    stream.update("replacement is longer", "part_2")
    stream.end()

    expect(root.textContent).toBe("replacement is longer")
    expect(root.firstElementChild).not.toBe(first)
  })

  test("blocks a dangerous link protocol split across updates", () => {
    const root = createRoot()
    const stream = createMarkdownStreamController(root)
    const prefix = "[safe](https://example.com) [bad](java"

    stream.update(prefix)
    stream.update(`${prefix}script:alert(1))`)
    stream.end()

    const links = root.querySelectorAll("a")
    expect(links).toHaveLength(2)
    expect(links[0]?.getAttribute("href")).toBe("https://example.com")
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(links[1]?.hasAttribute("href")).toBe(false)
  })

  test("retains managed image and document references across streaming chunks", () => {
    const root = createRoot()
    const stream = createMarkdownStreamController(root)
    const prefix = "![Chart](asset://01234567"
    stream.update(prefix)
    stream.update(`${prefix}89abcdef.png)\n\n[Report](asset://fedcba9876543210.docx)`)
    stream.end()
    expect(root.querySelector("img")?.getAttribute("data-resource-reference")).toBe("asset://0123456789abcdef.png")
    expect(root.querySelector("a")?.getAttribute("data-resource-reference")).toBe("asset://fedcba9876543210.docx")
    expect(root.querySelector("img")?.hasAttribute("src")).toBe(false)
  })

  test("blocks executable image sources", () => {
    const root = createRoot()
    const stream = createMarkdownStreamController(root)

    stream.update("![bad](data:image/svg+xml,x)")
    stream.end()

    const image = root.querySelector("img")
    expect(image).toBeTruthy()
    expect(image?.hasAttribute("src")).toBe(false)
  })

  test("does not turn raw model HTML into executable DOM", () => {
    const root = createRoot()
    const stream = createMarkdownStreamController(root)

    stream.update('<img src="x" onerror="alert(1)">')
    stream.end()

    expect(root.querySelector("img")).toBeNull()
    expect(root.querySelector("[onerror]")).toBeNull()
    expect(root.textContent).toContain("<img")
  })
})

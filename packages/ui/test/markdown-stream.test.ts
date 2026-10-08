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
  test("grapheme work stays incremental after a large settled prefix", () => {
    const root = createRoot()
    const animate = dom.window.HTMLElement.prototype.animate
    const segment = Intl.Segmenter.prototype.segment
    const animations: Animation[] = []
    dom.window.HTMLElement.prototype.animate = () => {
      const animation = { cancel() {}, onfinish: null } as unknown as Animation
      animations.push(animation)
      return animation
    }
    let processed = 0
    try {
      const stream = createMarkdownStreamController(root)
      let text = "settled ".repeat(128 * 1024)
      stream.update(text)
      Intl.Segmenter.prototype.segment = function (input) {
        processed += input.length
        return segment.call(this, input)
      }
      for (let update = 0; update < 100; update++) {
        text += "x"
        stream.update(text)
        for (const animation of animations.splice(0))
          animation.onfinish?.call(animation, new dom.window.Event("finish") as AnimationPlaybackEvent)
      }
      stream.end()
      expect(root.textContent).toBe(text)
      expect(processed).toBeLessThan(1000)
    } finally {
      Intl.Segmenter.prototype.segment = segment
      dom.window.HTMLElement.prototype.animate = animate
    }
  })

  test("small stream deltas retain one settled text run and compact source spans", () => {
    const root = createRoot()
    const stream = createMarkdownStreamController(root)
    const text = "steady ".repeat(400)
    for (let length = 1; length <= text.length; length++) stream.update(text.slice(0, length))
    stream.end()
    const paragraph = root.querySelector("p")!
    expect(paragraph.childNodes).toHaveLength(1)
    const node = paragraph.firstChild as Text
    expect(node.data).toBe(text)
    expect(stream.sourceAt(node, text.indexOf("steady", 20))).toBe(text.indexOf("steady", 20))
  })

  test("completed append motion merges text while preserving caret and source ownership", () => {
    const root = createRoot()
    document.body.append(root)
    const original = dom.window.HTMLElement.prototype.animate
    const animations: Animation[] = []
    dom.window.HTMLElement.prototype.animate = () => {
      const animation = { cancel() {}, onfinish: null } as unknown as Animation
      animations.push(animation)
      return animation
    }
    try {
      const stream = createMarkdownStreamController(root)
      stream.update("Original text. ")
      const settled = root.querySelector("p")!.firstChild as Text
      const before = settled.length
      stream.update("Original text. newly streamed text. ")
      const appended = root.querySelector("span")!.firstChild as Text
      const range = document.createRange()
      range.setStart(appended, 3)
      range.collapse(true)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
      for (const animation of animations)
        animation.onfinish?.call(animation, new dom.window.Event("finish") as AnimationPlaybackEvent)
      expect(root.querySelector("p")!.childNodes).toHaveLength(1)
      expect(document.getSelection()!.anchorNode).toBe(settled)
      expect(document.getSelection()!.anchorOffset).toBe(before + 3)
      expect(stream.sourceAt(settled, before + 3)).toBe(before + 3)
      stream.end()
    } finally {
      document.getSelection()?.removeAllRanges()
      dom.window.HTMLElement.prototype.animate = original
      root.remove()
    }
  })

  test.each([
    "Prefix **bold** [label](https://example.com/label) repeated label.\n\n",
    "Escaped \\*literal\\* &amp; `inline code` $x^2$ remain.\n\n",
    "First paragraph.\r\n\r\n- list item\r\n  - nested item\r\n\r\nFinal paragraph.\r\n",
    "<span>literal HTML</span> stays text.\n\n",
    "`a\nb`\n",
    "raw http://example.com/a trailing\n",
    "x $$currency literal $$x\n",
    "```ts\nconst value = 42\nconst second = 'text'\n```\n\n",
  ])("stream text points retain original source positions: %s", (markdown) => {
    const root = createRoot()
    const stream = createMarkdownStreamController(root)
    stream.update(markdown)
    stream.end()
    const walker = document.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      for (let offset = 0; offset < node.length; offset++) {
        if (!node.data[offset].trim()) continue
        const source = stream.sourceAt(node, offset)
        expect(source).toBeDefined()
        expect(markdown[source!]).toBe(node.data[offset])
      }
    }
  })

  test("repeated link labels retain their distinct consumed source positions", () => {
    const markdown = "[label](https://example.com/label) [label](https://example.com/label)\n\n"
    const root = createRoot()
    const stream = createMarkdownStreamController(root)
    stream.update(markdown)
    stream.end()
    const labels = root.querySelectorAll("a")
    expect(stream.sourceAt(labels[0].firstChild as Text, 0)).toBe(markdown.indexOf("label"))
    expect(stream.sourceAt(labels[1].firstChild as Text, 0)).toBe(markdown.indexOf("[label]", 1) + 1)
  })

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

    stream.update("![bad](data:text/html,x)")
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

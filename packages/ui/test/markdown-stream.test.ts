import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createMarkdownStreamController } from "../src/components/markdown-stream"

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
const dom = new JSDOM("<!doctype html><html><body></body></html>")

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

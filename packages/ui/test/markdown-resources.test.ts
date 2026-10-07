import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { createMarkdownParser } from "../src/context/markdown-parser"
import { createMarkdownStreamController } from "../src/components/markdown-stream"
import { observeMarkdownResources } from "../src/components/markdown-resources"
import { attachmentFromReference, type AttachmentFile } from "../src/components/attachment-card-utils"
import type { ResourceOpenController } from "../src/context/resource-open"

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://ui.example/" })
const previous = ["document", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
let sanitizeHtml: (input: string) => string
const parser = createMarkdownParser()
beforeAll(async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document })
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window })
  ;({ sanitizeHtml } = await import("../src/components/markdown-sanitize"))
})
afterAll(() => {
  parser.dispose()
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  dom.window.close()
})

const text = "![Cost chart](asset://0123456789abcdef.png)\n\nRead [Report.docx](asset://fedcba9876543210.docx)."
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function fixture() {
  const root = document.createElement("div")
  document.body.append(root)
  const opened: AttachmentFile[] = []
  const resources: ResourceOpenController = {
    resolveAttachmentReference(reference, filename) {
      const file = attachmentFromReference(reference, filename)
      return file ? { file, serverUrl: "https://backend.example" } : undefined
    },
    open: () => false,
    openAttachment(file) {
      opened.push(file)
      return true
    },
  }
  const dispose = observeMarkdownResources(root, resources)
  return {
    root,
    opened,
    dispose: () => {
      dispose()
      root.remove()
    },
  }
}

describe("Markdown managed resources", () => {
  test.each(["stream", "settled"])("renders and opens the same image and document in %s Markdown", async (mode) => {
    const f = fixture()
    try {
      if (mode === "stream") {
        const stream = createMarkdownStreamController(f.root)
        for (let size = 1; size <= text.length; size++) stream.update(text.slice(0, size))
        stream.end()
      } else f.root.innerHTML = sanitizeHtml(await parser.parse(text))
      await flush()
      const image = f.root.querySelector("img")!
      expect(image.getAttribute("src")).toBe("https://backend.example/asset/0123456789abcdef.png")
      expect(image.closest("a")?.getAttribute("href")).toBe(image.getAttribute("src"))
      image.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
      const documentLink = f.root.querySelector('a[data-resource-reference="asset://fedcba9876543210.docx"]')!
      expect(documentLink.getAttribute("href")).toBe("https://backend.example/asset/fedcba9876543210.docx")
      documentLink.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
      expect(f.opened.map(({ filename, mime }) => ({ filename, mime }))).toEqual([
        { filename: "Cost chart", mime: "image/png" },
        { filename: "Report.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      ])
    } finally {
      f.dispose()
    }
  })

  test("binds recycled document blocks without reprocessing or duplicating existing images", async () => {
    const f = fixture()
    try {
      f.root.innerHTML = sanitizeHtml(await parser.parse(text))
      await flush()
      const image = f.root.querySelector("img")
      const wrapper = image?.parentElement
      const block = document.createElement("div")
      block.innerHTML = sanitizeHtml(await parser.parse("[Data.pdf](asset://1111111111111111.pdf)"))
      f.root.append(block)
      await flush()
      expect(f.root.querySelector("img")).toBe(image)
      expect(image?.parentElement).toBe(wrapper)
      expect(f.root.querySelectorAll('[data-slot="markdown-resource-image"]')).toHaveLength(1)
      expect(block.querySelector("a")?.getAttribute("href")).toBe("https://backend.example/asset/1111111111111111.pdf")
      block.remove()
      f.root.append(block)
      await flush()
      block.querySelector("a")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
      expect(f.opened).toHaveLength(1)
    } finally {
      f.dispose()
    }
  })

  test("rejects unsafe references and preserves ordinary links and modifier clicks", async () => {
    const f = fixture()
    try {
      f.root.innerHTML = sanitizeHtml(
        await parser.parse(
          "[Bad](asset://../secret) [Web](https://example.org)\n\n![Bad](javascript:alert)\n\n" + text,
        ),
      )
      await flush()
      expect(f.root.querySelector('a[href="https://example.org"]')).not.toBeNull()
      expect(f.root.querySelector('img[src^="javascript:"]')).toBeNull()
      expect(f.root.querySelector('a[href*="secret"]')).toBeNull()
      const link = f.root.querySelector('a[data-resource-reference="asset://fedcba9876543210.docx"]')!
      link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true, cancelable: true }))
      expect(f.opened).toHaveLength(0)
    } finally {
      f.dispose()
    }
  })

  test("releases observation and activation with the Markdown owner", async () => {
    const f = fixture()
    f.dispose()
    f.root.innerHTML = sanitizeHtml(await parser.parse(text))
    await flush()
    expect(f.root.querySelector("img")?.hasAttribute("src")).toBe(false)
  })
})

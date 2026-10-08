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
  const references: unknown[] = []
  const resources: ResourceOpenController = {
    resolveUrl(reference) {
      return reference.kind === "asset" ? `https://backend.example/asset/${reference.url.slice(8)}` : undefined
    },
    async open(resource, options) {
      references.push({ resource, options })
      if (resource.kind === "asset") opened.push(attachmentFromReference(resource.url)!)
      return { status: "opened" }
    },
  }
  const dispose = observeMarkdownResources(root, resources)
  return {
    root,
    opened,
    references,
    dispose: () => {
      dispose()
      root.remove()
    },
  }
}

describe("Markdown managed resources", () => {
  test.each(["stream", "settled"])("preserves inline image previews in %s Markdown", async (mode) => {
    const f = fixture()
    const urls = ["data:image/png;base64,AAAA", "blob:https://ui.example/image"]
    const markdown = urls.map((url) => `![Chart](${url})`).join("\n\n")
    try {
      if (mode === "stream") {
        const stream = createMarkdownStreamController(f.root)
        stream.update(markdown)
        stream.end()
      } else f.root.innerHTML = sanitizeHtml(await parser.parse(markdown))
      await flush()
      const images = [...f.root.querySelectorAll("img")]
      expect(images.map((image) => image.getAttribute("src"))).toEqual(urls)
      expect(images.map((image) => image.parentElement?.getAttribute("title"))).toEqual(["Chart", "Chart"])
      for (const image of images) image.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
      expect(f.references).toHaveLength(2)
      expect(f.references[0]).toMatchObject({ resource: { kind: "image", url: urls[0], filename: "Chart" } })
    } finally {
      f.dispose()
    }
  })
  test.each(["stream", "settled"])(
    "opens workspace citations without browser navigation in %s Markdown",
    async (mode) => {
      const f = fixture()
      const markdown = "[`progress.ts:3–7`](packages/harness/src/agent/prompt/progress.ts#L3) and `src/plain.ts:42`"
      try {
        if (mode === "stream") {
          const stream = createMarkdownStreamController(f.root)
          for (let i = 1; i <= markdown.length; i++) stream.update(markdown.slice(0, i))
          stream.end()
        } else f.root.innerHTML = sanitizeHtml(await parser.parse(markdown))
        await flush()
        const reference = f.root.querySelector<HTMLElement>("[data-resource-reference]")!
        expect(reference).not.toBeNull()
        expect(reference.getAttribute("href")).toBeNull()
        const click = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })
        reference.dispatchEvent(click)
        expect(click.defaultPrevented).toBe(true)
        expect(f.references[0]).toMatchObject({
          resource: {
            kind: "workspace-file",
            path: "packages/harness/src/agent/prompt/progress.ts",
            location: { kind: "text", line: 3 },
          },
        })
        expect(f.root.querySelectorAll("[data-resource-reference]")).toHaveLength(1)
      } finally {
        f.dispose()
      }
    },
  )
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
      expect(image.closest("a")?.getAttribute("href")).toBeNull()
      image.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
      const documentLink = f.root.querySelector('a[data-resource-reference="asset://fedcba9876543210.docx"]')!
      expect(documentLink.getAttribute("href")).toBeNull()
      documentLink.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
      expect(f.opened.map(({ mime }) => mime)).toEqual([
        "image/png",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ])
      expect(f.references.at(-1)).toMatchObject({ resource: { filename: "Report.docx" } })
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
      expect(block.querySelector("a")?.getAttribute("href")).toBeNull()
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
      expect(f.references.at(-1)).toMatchObject({ options: { newTab: true } })
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

test("binds a sanitized explicit HTML file link and reports a rejected open without navigation", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const context = {
    state: "bound" as const,
    workspace: { id: "wsp_source", generation: 2, root: "/original" },
    directory: "docs",
  }
  const calls: unknown[] = []
  const dispose = observeMarkdownResources(
    root,
    {
      async open(reference, options) {
        calls.push({ reference, options })
        return { status: "unavailable", reason: "missing" }
      },
    },
    () => context,
  )
  try {
    root.innerHTML = '<a href="../src/a.ts#L2">source</a>'
    await flush()
    const link = root.querySelector("a")!
    const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(link.hasAttribute("href")).toBe(false)
    await flush()
    expect(link.getAttribute("data-resource-state")).toBe("unavailable")
    expect(calls[0]).toMatchObject({
      reference: { path: "../src/a.ts", location: { kind: "text", line: 2 } },
      options: { context },
    })
  } finally {
    dispose()
    root.remove()
  }
})

test("an older activation cannot overwrite a newer result on the same citation", async () => {
  const root = document.createElement("div")
  root.innerHTML = '<a data-resource-reference="src/a.ts#L2">source</a>'
  document.body.append(root)
  const pending: Array<(value: { status: "opened" | "cancelled" }) => void> = []
  const dispose = observeMarkdownResources(root, {
    open: () => new Promise((resolve) => pending.push(resolve)),
  })
  try {
    const link = root.querySelector("a")!
    for (let i = 0; i < 2; i++)
      link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
    pending[1]!({ status: "opened" })
    await flush()
    pending[0]!({ status: "cancelled" })
    await flush()
    expect(link.getAttribute("data-resource-state")).toBe("opened")
    expect(link.hasAttribute("aria-busy")).toBe(false)
    link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }))
    dispose()
    expect(link.hasAttribute("aria-busy")).toBe(false)
  } finally {
    dispose()
    root.remove()
  }
})

test("binding a long document resolves only images and leaves existing blocks untouched on append", async () => {
  const root = document.createElement("div")
  root.innerHTML = Array.from(
    { length: 2000 },
    (_, index) => `<p><a data-resource-reference="src/file-${index}.ts#L2">source</a></p>`,
  ).join("")
  document.body.append(root)
  let resolutions = 0
  const dispose = observeMarkdownResources(root, {
    async open() {
      return { status: "opened" }
    },
    resolveUrl(reference) {
      resolutions++
      return reference.kind === "asset" ? `https://backend.example/asset/${reference.url.slice(8)}` : undefined
    },
  })
  let existingWrites = 0
  const probe = new dom.window.MutationObserver((records) => {
    existingWrites += records.length
  })
  try {
    await flush()
    expect(resolutions).toBe(0)
    probe.observe(root.firstElementChild!, { attributes: true, childList: true, subtree: true })
    const block = document.createElement("p")
    block.innerHTML = '<img data-resource-reference="asset://0123456789abcdef.png" alt="chart">'
    root.append(block)
    await flush()
    expect(resolutions).toBeLessThanOrEqual(3)
    expect(block.querySelector("img")?.src).toBe("https://backend.example/asset/0123456789abcdef.png")
    expect(existingWrites).toBe(0)
    expect(root.querySelectorAll("[data-reference-icon]")).toHaveLength(2000)
  } finally {
    probe.disconnect()
    dispose()
    root.remove()
  }
})

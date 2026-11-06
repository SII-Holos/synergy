import { describe, expect, test, beforeAll } from "bun:test"

// The Markdown pipeline feeds model/tool-authored HTML into innerHTML, and the
// SPA CSP allows inline scripts, so unsanitized output is an XSS vector (#350
// D5). sanitizeHtml runs DOMPurify against the browser DOM; we exercise it here
// against jsdom (a spec-compliant DOM — happy-dom mis-parses bare <script>
// fragments, so it cannot validate this) set up as the global window before the
// module is imported, so DOMPurify binds to it.
let sanitizeHtml: (html: string) => string

beforeAll(async () => {
  const { JSDOM } = await import("jsdom")
  const dom = new JSDOM("<!doctype html>")
  ;(globalThis as any).window = dom.window
  ;(globalThis as any).document = dom.window.document
  ;({ sanitizeHtml } = await import("../src/components/markdown-sanitize"))
})

describe("Markdown sanitizeHtml (#350 D5)", () => {
  test("removes <script> payloads but keeps surrounding text", () => {
    const out = sanitizeHtml("before<script>alert(document.cookie)</script>after")
    expect(out).not.toContain("<script")
    expect(out).toContain("before")
    expect(out).toContain("after")
  })

  test("strips event-handler XSS while keeping the element", () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(1)">')
    expect(out).not.toContain("onerror")
    expect(out).not.toContain("alert(1)")
    expect(out).toContain("<img")
  })

  test("neutralizes javascript: URLs", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain("javascript:")
    expect(out).toContain(">x</a>")
  })

  test("removes global style blocks while preserving inline styles", () => {
    const out = sanitizeHtml(
      'before<style>body { display: none !important; }</style><span style="color:#abcdef">visible</span>',
    )

    expect(out).not.toContain("<style")
    expect(out).not.toContain("body { display: none")
    expect(out).toContain("before")
    expect(out).toContain('style="color:#abcdef"')
    expect(out).toContain("visible")
  })

  test("preserves shiki code blocks (class + inline style + text)", () => {
    const out = sanitizeHtml('<pre class="shiki"><code><span style="color:#abcdef">const</span></code></pre>')
    expect(out).toContain('class="shiki"')
    expect(out).toContain("color:#abcdef")
    expect(out).toContain("const")
  })

  test("preserves katex MathML output", () => {
    const out = sanitizeHtml('<span class="katex"><math><mrow><mi>x</mi></mrow></math></span>')
    expect(out).toContain('class="katex"')
    expect(out).toContain("<math")
    expect(out).toContain("<mi>x</mi>")
  })

  test("preserves the KaTeX source annotation used by click-to-copy", async () => {
    const katex = (await import("katex")).default
    const source = String.raw`G_{\mathrm{int}}`
    const out = sanitizeHtml(katex.renderToString(source, { throwOnError: false }))
    const root = document.createElement("div")
    root.innerHTML = out

    expect(root.querySelector(".katex")).not.toBeNull()
    expect(root.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(source)
  })

  test("keeps allowed KaTeX annotations inert", () => {
    const out = sanitizeHtml(
      '<math><semantics><annotation encoding="application/x-tex" onclick="alert(1)">x<script>alert(2)</script></annotation></semantics></math>',
    )

    expect(out).toContain('<annotation encoding="application/x-tex">x</annotation>')
    expect(out).not.toContain("onclick")
    expect(out).not.toContain("<script")
    expect(out).not.toContain("alert")
  })
})

// Managed references (`asset:`, `note:`, workspace paths) are not browser-native
// schemes, so DOMPurify's URI allowlist dropped them: raw-HTML images lost their
// pixels and document links lost their target, with no error surface anywhere.
// They are preserved as the `data-resource-reference` attribute the resource
// observer resolves, while non-managed schemes keep their original treatment.
describe("Markdown sanitizeHtml managed references", () => {
  const referenceOf = (html: string, selector: string) => {
    const root = document.createElement("div")
    root.innerHTML = sanitizeHtml(html)
    return root.querySelector(selector)?.getAttribute("data-resource-reference")
  }

  test("keeps a raw-HTML asset image resolvable instead of dropping its src", () => {
    const html = '<img src="asset://0123456789abcdef.png" width="600" alt="chart">'
    expect(referenceOf(html, "img")).toBe("asset://0123456789abcdef.png")
    const root = document.createElement("div")
    root.innerHTML = sanitizeHtml(html)
    expect(root.querySelector("img")?.getAttribute("width")).toBe("600")
    expect(root.querySelector("img")?.hasAttribute("src")).toBe(false)
  })

  test("keeps raw-HTML document and note links openable", () => {
    expect(referenceOf('<a href="asset://fedcba9876543210.docx">doc</a>', "a")).toBe("asset://fedcba9876543210.docx")
    expect(referenceOf('<a href="note://nte_example">note</a>', "a")).toBe("note://nte_example")
  })

  test("keeps workspace-relative paths as references", () => {
    expect(referenceOf('<img src="docs/chart.png">', "img")).toBe("docs/chart.png")
  })

  test("collapses a managed srcset to its single target", () => {
    const root = document.createElement("div")
    root.innerHTML = sanitizeHtml(
      '<img srcset="asset://0123456789abcdef.png 1x, asset://fedcba9876543210.png 2x" alt="chart">',
    )
    const image = root.querySelector("img")!
    expect(image.getAttribute("data-resource-reference")).toBe("asset://0123456789abcdef.png")
    expect(image.getAttribute("data-resource-attribute")).toBe("srcset")
    expect(image.hasAttribute("srcset")).toBe(false)
  })

  test("keeps audio, video and poster references", () => {
    const root = document.createElement("div")
    root.innerHTML = sanitizeHtml(
      '<video src="asset://0123456789abcdef.mp4" poster="asset://fedcba9876543210.png" controls></video>' +
        '<audio src="asset://0123456789abcdef.mp3" controls></audio>',
    )
    const video = root.querySelector("video")!
    expect(video.getAttribute("data-resource-reference")).toBe("asset://0123456789abcdef.mp4")
    expect(video.hasAttribute("controls")).toBe(true)
    expect(root.querySelector("audio")?.getAttribute("data-resource-reference")).toBe("asset://0123456789abcdef.mp3")
  })

  test("rescues a framed managed document before the frame is removed", () => {
    expect(referenceOf('<iframe src="asset://0123456789abcdef.html"></iframe>', "span")).toBe(
      "asset://0123456789abcdef.html",
    )
    expect(referenceOf('<object data="asset://fedcba9876543210.pdf"></object>', "span")).toBe(
      "asset://fedcba9876543210.pdf",
    )
  })

  test("normalizes a case-varied scheme", () => {
    expect(referenceOf('<img src="ASSET://0123456789abcdef.png">', "img")).toBe("asset://0123456789abcdef.png")
  })

  test("treats a file URL exactly as Markdown syntax does", () => {
    // `ResourceReference.parse` maps `file:` to a workspace-file reference, so the
    // raw-HTML and Markdown spellings must agree. The workspace-containment check
    // happens when the observer resolves the reference, not here.
    expect(referenceOf('<img src="file:///Users/example/inside.png">', "img")).toBe("file:///Users/example/inside.png")
  })

  test("still removes script and unsupported schemes", () => {
    for (const html of [
      '<img src="javascript:alert(1)">',
      '<a href="javascript:alert(1)">x</a>',
      '<img src="vscode://file/etc/passwd">',
    ]) {
      const root = document.createElement("div")
      root.innerHTML = sanitizeHtml(html)
      const element = root.firstElementChild!
      expect(element.getAttribute("data-resource-reference")).toBeNull()
      expect(element.getAttribute("src")).toBeNull()
      expect(element.getAttribute("href")).toBeNull()
    }
    const root = document.createElement("div")
    root.innerHTML = sanitizeHtml('<iframe src="https://evil.example/x"></iframe>')
    expect(root.textContent).toBe("")
    expect(root.querySelector("iframe")).toBeNull()
  })
})

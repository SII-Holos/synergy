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
  const dom = new JSDOM("")
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
})

import { afterAll, describe, expect, test } from "bun:test"
import { setupSolidDOM } from "../support/solid-dom"

const closeDOM = await setupSolidDOM()
afterAll(closeDOM)
const { renderHtmlDocument, RENDER_HTML_CSP } = await import("../../src/components/render-html")

describe("render HTML isolation", () => {
  test("injects a strict no-script, no-network, no-form content security policy", () => {
    expect(RENDER_HTML_CSP).toContain("default-src 'none'")
    expect(RENDER_HTML_CSP).toContain("script-src 'none'")
    expect(RENDER_HTML_CSP).toContain("connect-src 'none'")
    expect(RENDER_HTML_CSP).toContain("frame-src 'none'")
    expect(RENDER_HTML_CSP).toContain("object-src 'none'")
    expect(RENDER_HTML_CSP).toContain("form-action 'none'")

    const document = renderHtmlDocument("<p>Safe</p>", ":root { color-scheme: light; }")
    expect(document).toContain('http-equiv="Content-Security-Policy"')
    expect(document).toContain("<p>Safe</p>")
    expect(document).toContain("var(--render-font-family-sans")
    expect(document).toContain("var(--render-font-family-mono")
  })

  test("puts the host policy first even for full documents and misleading head comments", () => {
    for (const html of [
      '<!-- <head> --><img src="https://invalid.example/image"><p>Safe</p>',
      '<html><img src="https://invalid.example/early"><head><style>p { font-weight: 500; }</style></head><body><p>Safe</p></body></html>',
    ]) {
      const doc = new DOMParser().parseFromString(
        renderHtmlDocument(html, ":root { color-scheme: light; }"),
        "text/html",
      )
      expect(doc.head.firstElementChild?.getAttribute("content")).toBe(RENDER_HTML_CSP)
      expect(doc.querySelectorAll("meta").length).toBe(1)
      expect(doc.body.textContent).toContain("Safe")
    }
  })

  test("removes MathML navigation without removing static formulas", () => {
    const html = `<math href="https://invalid.example/leave"><mi href="/leave" tabindex="0">x</mi><mo xlink:href="/leave">+</mo><mn>1</mn></math>`
    const doc = new DOMParser().parseFromString(renderHtmlDocument(html, ":root { color-scheme: light; }"), "text/html")
    const math = doc.querySelector("math")!
    expect(math.getAttribute("href")).toBeNull()
    expect(math.querySelector("mi")?.getAttribute("href")).toBeNull()
    expect(math.querySelector("mo")?.getAttribute("xlink:href")).toBeNull()
    expect(math.textContent).toBe("x+1")
  })

  test("removes authored navigation and host markers while preserving static CSS and SVG references", () => {
    const html = `<meta http-equiv="refresh" content="0;url=/leave"><base href="https://invalid.example"><form action="/leave"><button>Submit</button></form><style data-synergy-render-theme>p { font-weight: 500; }</style><a href="/leave" target="_top">Link</a><svg><defs><rect id="shape" /></defs><use href="#shape" /><use href="https://invalid.example/shape" /><a xlink:href="/leave"><text>Link</text><set attributeName="href" to="/leave" /></a></svg><details><summary>More</summary>Detail</details>`
    const doc = new DOMParser().parseFromString(renderHtmlDocument(html, ":root { color-scheme: light; }"), "text/html")
    expect(doc.querySelectorAll("base, form, set, meta[http-equiv=refresh]").length).toBe(0)
    expect(doc.querySelectorAll("a[href], a[xlink\\:href], a[target]").length).toBe(0)
    expect(doc.querySelectorAll("style[data-synergy-render-theme]").length).toBe(1)
    expect(doc.querySelectorAll("use")[0]?.getAttribute("href")).toBe("#shape")
    expect(doc.querySelectorAll("use")[1]?.getAttribute("href")).toBeNull()
    expect(doc.querySelector("details summary")?.textContent).toBe("More")
    expect(doc.documentElement.innerHTML).toContain("p { font-weight: 500; }")
  })
})

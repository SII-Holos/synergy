import { describe, expect, test } from "bun:test"
import { renderHtmlDocument, RENDER_HTML_CSP } from "../../src/components/render-html"

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
  })
})

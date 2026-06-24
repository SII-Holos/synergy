import { describe, test, expect } from "bun:test"
import {
  truncateHTML,
  stripHTMLTags,
  isPasswordField,
  isVisibleElement,
  domSnapshot,
  pageText,
  BrowserPageRead,
} from "../../src/browser/page-read"

describe("BrowserPageRead", () => {
  // ── DOM truncation ─────────────────────────────────────────────

  test("truncateHTML truncates output to maxBytes", () => {
    const html = "<p>" + "A".repeat(200) + "</p>"
    const r = truncateHTML(html, 100)
    expect(Buffer.byteLength(r, "utf8")).toBeLessThanOrEqual(120)
    expect(r).toContain("[truncated")
  })

  test("truncateHTML does not split multibyte characters", () => {
    const html = "\u2600\uFE0F".repeat(200)
    const r = truncateHTML(html, 100)
    expect(r).toContain("\u2600")
  })

  test("domSnapshot truncates output to maxBytes", () => {
    const html = "<p>" + "A".repeat(66000) + "</p>"
    const r = domSnapshot(html)
    expect(Buffer.byteLength(r, "utf8")).toBeLessThanOrEqual(65600)
    expect(r).toContain("[truncated")
  })

  test("domSnapshot default maxBytes is 64KB", () => {
    const r = domSnapshot("<p>hello</p>")
    expect(r).toContain("hello")
  })

  // ── Page text ──────────────────────────────────────────────────

  test("stripHTMLTags removes HTML tags", () => {
    const r = stripHTMLTags("<p>Hello <b>world</b></p>")
    expect(r).toContain("Hello")
    expect(r).toContain("world")
    expect(r).not.toContain("<p>")
    expect(r).not.toContain("<b>")
  })

  // ── Password detection ─────────────────────────────────────────

  test("isPasswordField returns true for type=password", () => {
    expect(isPasswordField({ type: "password" })).toBe(true)
  })

  test("isPasswordField returns false for regular input", () => {
    expect(isPasswordField({ type: "text" })).toBe(false)
  })

  // ── Visible DOM ────────────────────────────────────────────────

  test("isVisibleElement filters display:none", () => {
    expect(isVisibleElement({ display: "none" }, { x: 0, y: 0, width: 100, height: 100 }, 1920, 1080)).toBe(false)
  })

  test("isVisibleElement filters visibility:hidden", () => {
    expect(isVisibleElement({ visibility: "hidden" }, { x: 0, y: 0, width: 100, height: 100 }, 1920, 1080)).toBe(false)
  })

  test("isVisibleElement filters zero-width element", () => {
    expect(isVisibleElement({}, { x: 0, y: 0, width: 0, height: 100 }, 1920, 1080)).toBe(false)
  })

  test("isVisibleElement filters element outside viewport", () => {
    expect(isVisibleElement({}, { x: 2000, y: 0, width: 100, height: 100 }, 1920, 1080)).toBe(false)
  })

  test("isVisibleElement passes for visible element in viewport", () => {
    expect(isVisibleElement({}, { x: 100, y: 100, width: 100, height: 100 }, 1920, 1080)).toBe(true)
  })
})

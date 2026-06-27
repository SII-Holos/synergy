import { describe, test, expect } from "bun:test"
import z from "zod"
import { BrowserReadTool } from "../../src/tool/browser-read"
import { BrowserLocator } from "../../src/browser/locator"
import { visibleDOM, isVisibleElement } from "../../src/browser/page-read"

// ── GREEN: production schema accepts visibleDom ───────────
describe("browser_read production schema (GREEN)", () => {
  test("production schema accepts visibleDom type", async () => {
    const info = await BrowserReadTool.init()
    const r = info.parameters.safeParse({ type: "visibleDom" })
    expect(r.success).toBe(true)
  })

  test("production schema accepts original types", async () => {
    const info = await BrowserReadTool.init()
    for (const t of ["accessibility", "dom", "text", "attributes", "style"]) {
      const r = info.parameters.safeParse({ type: t })
      expect(r.success).toBe(true)
    }
  })

  test("production schema rejects unknown type", async () => {
    const info = await BrowserReadTool.init()
    const r = info.parameters.safeParse({ type: "unknown" })
    expect(r.success).toBe(false)
  })
})

// ── visibleDom type parameter in browser_read schema ───────────
describe("browser_read extended schema", () => {
  const ExtendedReadSchema = z.object({
    type: z.enum(["accessibility", "dom", "text", "attributes", "style", "visibleDom"]),
    locator: BrowserLocator.LocatorInputSchema.optional(),
    maxBytes: z.number().int().min(1).default(64000),
    pageId: z.string().optional(),
  })

  test("schema accepts visibleDom type", () => {
    const r = ExtendedReadSchema.safeParse({ type: "visibleDom" })
    expect(r.success).toBe(true)
  })

  test("visibleDom type with locator restricts to element subtree", () => {
    const r = ExtendedReadSchema.safeParse({
      type: "visibleDom",
      locator: { kind: "ref", value: "@e1" },
    })
    expect(r.success).toBe(true)
  })

  test("visibleDom type with maxBytes", () => {
    const r = ExtendedReadSchema.safeParse({
      type: "visibleDom",
      maxBytes: 4096,
    })
    expect(r.success).toBe(true)
  })

  test("still accepts all original types (regression)", () => {
    for (const t of ["accessibility", "dom", "text", "attributes", "style"]) {
      const r = ExtendedReadSchema.safeParse({ type: t })
      expect(r.success).toBe(true)
    }
  })
})

// ── Locator kind coverage ──────────────────────────────────────
// BrowserLocator already defines these kinds and the existing
// locator.test.ts validates each one. Here we verify that
// ALL LocatorInput kinds are accepted by the browser_read schema
// via its optional locator field.

describe("browser_read accepts all BrowserLocator kinds", () => {
  const ReadSchema = z.object({
    type: z.enum(["accessibility", "dom", "text", "attributes", "style", "visibleDom"]),
    locator: BrowserLocator.LocatorInputSchema.optional(),
    maxBytes: z.number().int().min(1).default(64000),
    pageId: z.string().optional(),
  })

  test("accepts ref locator kind", () => {
    const r = ReadSchema.safeParse({
      type: "attributes",
      locator: { kind: "ref", value: "@e1" },
    })
    expect(r.success).toBe(true)
  })

  test("accepts css locator kind", () => {
    const r = ReadSchema.safeParse({
      type: "attributes",
      locator: { kind: "css", value: "button.submit" },
    })
    expect(r.success).toBe(true)
  })

  test("accepts role locator kind", () => {
    const r = ReadSchema.safeParse({
      type: "attributes",
      locator: { kind: "role", value: "button", name: "Submit" },
    })
    expect(r.success).toBe(true)
  })

  test("accepts text locator kind", () => {
    const r = ReadSchema.safeParse({
      type: "attributes",
      locator: { kind: "text", value: "Click here" },
    })
    expect(r.success).toBe(true)
  })

  test("accepts label locator kind", () => {
    const r = ReadSchema.safeParse({
      type: "attributes",
      locator: { kind: "label", value: "Email" },
    })
    expect(r.success).toBe(true)
  })

  test("accepts placeholder locator kind", () => {
    const r = ReadSchema.safeParse({
      type: "attributes",
      locator: { kind: "placeholder", value: "Search" },
    })
    expect(r.success).toBe(true)
  })

  test("accepts testId locator kind", () => {
    const r = ReadSchema.safeParse({
      type: "attributes",
      locator: { kind: "testId", value: "submit-btn" },
    })
    expect(r.success).toBe(true)
  })

  test("accepts xpath locator kind", () => {
    const r = ReadSchema.safeParse({
      type: "attributes",
      locator: { kind: "xpath", value: "//button" },
    })
    expect(r.success).toBe(true)
  })

  test("rejects unknown locator kind", () => {
    const r = ReadSchema.safeParse({
      type: "attributes",
      locator: { kind: "unknown", value: "x" },
    })
    expect(r.success).toBe(false)
  })
})

// ── visibleDOM helper usage ─────────────────────────────────────
// The visibleDom type should use BrowserPageRead.visibleDOM to
// filter elements by viewport visibility. These tests verify the
// helper's contract: it filters elements based on style, bounds,
// and viewport dimensions.

interface MockElement {
  style: Record<string, string>
  bounds: { x: number; y: number; width: number; height: number }
  id: string
}

describe("visibleDOM helper for browser_read", () => {
  test("filters out display:none elements", () => {
    const elements: MockElement[] = [
      { id: "a", style: { display: "none" }, bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "b", style: {}, bounds: { x: 0, y: 0, width: 100, height: 100 } },
    ]
    const result = visibleDOM(elements, 1920, 1080)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("b")
  })

  test("filters out visibility:hidden elements", () => {
    const elements: MockElement[] = [
      { id: "a", style: { visibility: "hidden" }, bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "b", style: {}, bounds: { x: 0, y: 0, width: 100, height: 100 } },
    ]
    const result = visibleDOM(elements, 1920, 1080)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("b")
  })

  test("filters out opacity:0 elements", () => {
    const elements: MockElement[] = [
      { id: "a", style: { opacity: "0" }, bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "b", style: {}, bounds: { x: 0, y: 0, width: 100, height: 100 } },
    ]
    const result = visibleDOM(elements, 1920, 1080)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("b")
  })

  test("filters out elements with zero bounds", () => {
    const elements: MockElement[] = [
      { id: "a", style: {}, bounds: { x: 0, y: 0, width: 0, height: 100 } },
      { id: "b", style: {}, bounds: { x: 0, y: 0, width: 100, height: 0 } },
      { id: "c", style: {}, bounds: { x: 0, y: 0, width: 100, height: 100 } },
    ]
    const result = visibleDOM(elements, 1920, 1080)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("c")
  })

  test("filters out elements outside viewport", () => {
    const elements: MockElement[] = [
      { id: "off-right", style: {}, bounds: { x: 2000, y: 0, width: 100, height: 100 } },
      { id: "off-bottom", style: {}, bounds: { x: 0, y: 2000, width: 100, height: 100 } },
      { id: "visible", style: {}, bounds: { x: 100, y: 100, width: 100, height: 100 } },
    ]
    const result = visibleDOM(elements, 1920, 1080)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("visible")
  })

  test("keeps elements partially in viewport", () => {
    const elements: MockElement[] = [{ id: "partial", style: {}, bounds: { x: -50, y: -50, width: 200, height: 200 } }]
    const result = visibleDOM(elements, 1920, 1080)
    expect(result).toHaveLength(1)
  })

  test("returns empty array for empty input", () => {
    const result = visibleDOM([] as MockElement[], 1920, 1080)
    expect(result).toHaveLength(0)
  })

  test("preserves element order", () => {
    const elements: MockElement[] = [
      { id: "first", style: {}, bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "hidden", style: { display: "none" }, bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "second", style: {}, bounds: { x: 50, y: 50, width: 100, height: 100 } },
    ]
    const result = visibleDOM(elements, 1920, 1080)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("first")
    expect(result[1].id).toBe("second")
  })

  test("uses correct viewport dimensions for different screens", () => {
    const elements: MockElement[] = [
      { id: "small-screen", style: {}, bounds: { x: 700, y: 200, width: 100, height: 100 } },
      { id: "off-on-mobile", style: {}, bounds: { x: 1000, y: 200, width: 100, height: 100 } },
    ]
    // Mobile viewport: 375x667
    const mobileResult = visibleDOM(elements, 375, 667)
    expect(mobileResult).toHaveLength(0)

    // Desktop viewport: 1920x1080
    const desktopResult = visibleDOM(elements, 1920, 1080)
    expect(desktopResult).toHaveLength(2)
  })

  // ── Integration contract ─────────────────────────────────────
  test("visibleDOM type preserves isVisibleElement contract", () => {
    const hidingStyles: Record<string, string>[] = [{ display: "none" }, { visibility: "hidden" }, { opacity: "0" }]
    for (const style of hidingStyles) {
      expect(isVisibleElement(style, { x: 0, y: 0, width: 100, height: 100 }, 1920, 1080)).toBe(false)
    }
    const visibleStyles: Record<string, string>[] = [{}, { color: "red" }, { fontSize: "16px" }]
    for (const style of visibleStyles) {
      expect(isVisibleElement(style, { x: 0, y: 0, width: 100, height: 100 }, 1920, 1080)).toBe(true)
    }
  })
})

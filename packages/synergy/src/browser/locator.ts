import z from "zod"

import type { BrowserTab, AccessibilityElement } from "./tab.js"
export namespace BrowserLocator {
  const RegexValueSchema = z.object({
    regex: z.string().min(1).describe("JavaScript regular expression source."),
    flags: z
      .string()
      .regex(/^(?!.*([dgimsuvy]).*\1)(?!.*u.*v)(?!.*v.*u)[dgimsuvy]*$/)
      .optional()
      .describe("JavaScript regular expression flags."),
  })

  const ValueSchema = z.union([z.string(), RegexValueSchema])

  /** Zod schema for LocatorInput — discriminated on `kind`. */
  export const LocatorInputSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ref"), value: z.string().min(1) }),
    z.object({ kind: z.literal("css"), value: z.string().min(1) }),
    z.object({
      kind: z.literal("role"),
      value: z.string().min(1),
      name: ValueSchema.optional(),
    }),
    z.object({
      kind: z.literal("text"),
      value: ValueSchema,
      exact: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("label"),
      value: ValueSchema,
      exact: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("placeholder"),
      value: ValueSchema,
      exact: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("testId"), value: z.string().min(1) }),
    z.object({ kind: z.literal("xpath"), value: z.string().min(1) }),
  ])

  export type LocatorInput = z.infer<typeof LocatorInputSchema>

  /** Validate an unknown value as a LocatorInput. */
  export function validateLocator(locator: unknown): { ok: boolean; message?: string } {
    const result = LocatorInputSchema.safeParse(locator)
    if (result.success) return { ok: true }
    return { ok: false, message: result.error.message }
  }

  export interface ResolvedElement {
    visible: boolean
    enabled: boolean
    editable: boolean
    x: number
    y: number
    width: number
    height: number
  }

  export interface ActionabilityResult {
    actionable: boolean
    visible: boolean
    enabled: boolean
    editable: boolean
    failures: string[]
    bounds: { x: number; y: number; width: number; height: number }
  }

  /**
   * Check whether an element is actionable for interaction.
   *
   * - Not visible → failure
   * - Not enabled → failure
   * - Non-editable elements (e.g. `<div>`) are reported as editable:false but
   *   do NOT cause a failure on their own.
   */
  export function checkActionable(el: ResolvedElement): ActionabilityResult {
    const failures: string[] = []
    if (!el.visible) failures.push("visible")
    if (!el.enabled) failures.push("enabled")

    return {
      actionable: failures.length === 0,
      visible: el.visible,
      enabled: el.enabled,
      editable: el.editable,
      failures,
      bounds: {
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
      },
    }
  }

  // ── helpers ──────────────────────────────────────────────────────

  function matchesValue(pattern: z.infer<typeof ValueSchema>, text: string, exact?: boolean): boolean {
    if (typeof pattern === "object") {
      try {
        return new RegExp(pattern.regex, pattern.flags).test(text)
      } catch {
        return false
      }
    }
    if (exact) return text === pattern
    return text.includes(pattern)
  }

  function findInTree(
    elements: AccessibilityElement[],
    predicate: (el: AccessibilityElement) => boolean,
  ): AccessibilityElement | null {
    for (const el of elements) {
      if (predicate(el)) return el
      if (el.children.length > 0) {
        const found = findInTree(el.children, predicate)
        if (found) return found
      }
    }
    return null
  }

  function findAllInTree(
    elements: AccessibilityElement[],
    predicate: (el: AccessibilityElement) => boolean,
  ): AccessibilityElement[] {
    const result: AccessibilityElement[] = []
    for (const el of elements) {
      if (predicate(el)) result.push(el)
      if (el.children.length > 0) {
        result.push(...findAllInTree(el.children, predicate))
      }
    }
    return result
  }

  async function resolveRefElement(tab: BrowserTab, ref: string): Promise<ResolvedElement | null> {
    const resolved = await tab.resolveRef(ref)
    if (!resolved) return null
    return {
      visible: resolved.width > 0 && resolved.height > 0,
      enabled: true,
      editable: false,
      x: resolved.x,
      y: resolved.y,
      width: resolved.width,
      height: resolved.height,
    }
  }

  async function evaluateBox(tab: BrowserTab, existsExpr: string, boxExpr: string): Promise<ResolvedElement | null> {
    const exists = await tab.evaluate(existsExpr)
    if (!exists) return null
    const box = (await tab.evaluate(boxExpr)) as {
      x: number
      y: number
      width: number
      height: number
    } | null
    if (!box) return null
    return {
      visible: box.width > 0 && box.height > 0,
      enabled: true,
      editable: false,
      ...box,
    }
  }

  // ── resolve / resolveAll ─────────────────────────────────────────

  /**
   * Resolve a single element matching the locator.
   * Returns null if no element matches.
   */
  export async function resolve(tab: BrowserTab, locator: LocatorInput): Promise<ResolvedElement | null> {
    const snapshot = await tab.snapshot().catch(() => ({ elements: [] as AccessibilityElement[], truncated: false }))

    switch (locator.kind) {
      case "ref": {
        const el = findInTree(snapshot.elements, (e) => e.ref === locator.value)
        if (!el?.ref) return null
        return resolveRefElement(tab, el.ref)
      }
      case "role": {
        const el = findInTree(snapshot.elements, (e) => {
          if (e.role !== locator.value) return false
          if (locator.name === undefined) return true
          return matchesValue(locator.name, e.name)
        })
        if (!el?.ref) return null
        return resolveRefElement(tab, el.ref)
      }
      case "text":
      case "label": {
        const el = findInTree(snapshot.elements, (e) => matchesValue(locator.value, e.name, locator.exact))
        if (!el?.ref) return null
        return resolveRefElement(tab, el.ref)
      }
      case "placeholder": {
        const el = findInTree(snapshot.elements, (e) => {
          const v = e.value ?? ""
          return matchesValue(locator.value, v, locator.exact)
        })
        if (!el?.ref) return null
        return resolveRefElement(tab, el.ref)
      }
      case "css": {
        return evaluateBox(
          tab,
          `!!document.querySelector(${JSON.stringify(locator.value)})`,
          `(function(){const e=document.querySelector(${JSON.stringify(locator.value)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`,
        )
      }
      case "xpath": {
        const escaped = locator.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        return evaluateBox(
          tab,
          `!!document.evaluate("${escaped}", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`,
          `(function(){const e=document.evaluate("${escaped}", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`,
        )
      }
      case "testId": {
        return evaluateBox(
          tab,
          `!!document.querySelector('[data-testid=${JSON.stringify(locator.value)}]')`,
          `(function(){const e=document.querySelector('[data-testid=${JSON.stringify(locator.value)}]');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`,
        )
      }
      default:
        return null
    }
  }

  /**
   * Resolve all elements matching the locator.
   * Returns an empty array if no elements match.
   */
  export async function resolveAll(tab: BrowserTab, locator: LocatorInput): Promise<ResolvedElement[]> {
    const snapshot = await tab.snapshot().catch(() => ({ elements: [] as AccessibilityElement[], truncated: false }))

    switch (locator.kind) {
      case "ref": {
        const el = findInTree(snapshot.elements, (e) => e.ref === locator.value)
        if (!el?.ref) return []
        const resolved = await resolveRefElement(tab, el.ref)
        return resolved ? [resolved] : []
      }
      case "role": {
        const els = findAllInTree(snapshot.elements, (e) => {
          if (e.role !== locator.value) return false
          if (locator.name === undefined) return true
          return matchesValue(locator.name, e.name)
        })
        return resolveAllRefs(tab, els)
      }
      case "text":
      case "label": {
        const els = findAllInTree(snapshot.elements, (e) => matchesValue(locator.value, e.name, locator.exact))
        return resolveAllRefs(tab, els)
      }
      case "placeholder": {
        const els = findAllInTree(snapshot.elements, (e) => {
          const v = e.value ?? ""
          return matchesValue(locator.value, v, locator.exact)
        })
        return resolveAllRefs(tab, els)
      }
      // css/xpath/testId: resolveAll is not supported via evaluate (single element only)
      // Fall through to resolve a single element
      default: {
        const single = await resolve(tab, locator)
        return single ? [single] : []
      }
    }
  }

  async function resolveAllRefs(tab: BrowserTab, els: AccessibilityElement[]): Promise<ResolvedElement[]> {
    const results: ResolvedElement[] = []
    for (const el of els) {
      if (!el.ref) continue
      const resolved = await resolveRefElement(tab, el.ref)
      if (resolved) results.push(resolved)
    }
    return results
  }

  /**
   * Resolve a snapshot-based locator to a CDP backend node reference.
   * Returns null for evaluate-based locators (css, xpath, testId) or if the element is not found.
   */
  export async function resolveLocatorRef(
    tab: BrowserTab,
    locator: BrowserLocator.LocatorInput,
  ): Promise<{ backendNodeId: number; x: number; y: number; width: number; height: number } | null> {
    const snapshot = await tab.snapshot().catch(() => ({ elements: [] as AccessibilityElement[], truncated: false }))

    let ref: string | null = null
    switch (locator.kind) {
      case "ref": {
        const el = findInTree(snapshot.elements, (e) => e.ref === locator.value)
        ref = el?.ref ?? null
        break
      }
      case "role": {
        const el = findInTree(snapshot.elements, (e) => {
          if (e.role !== locator.value) return false
          if (locator.name === undefined) return true
          return matchesValue(locator.name, e.name)
        })
        ref = el?.ref ?? null
        break
      }
      case "text":
      case "label": {
        const el = findInTree(snapshot.elements, (e) => matchesValue(locator.value, e.name, locator.exact))
        ref = el?.ref ?? null
        break
      }
      case "placeholder": {
        const el = findInTree(snapshot.elements, (e) => {
          const v = e.value ?? ""
          return matchesValue(locator.value, v, locator.exact)
        })
        ref = el?.ref ?? null
        break
      }
      default:
        return null
    }

    if (!ref) return null
    return tab.resolveRef(ref)
  }

  /**
   * Build a JavaScript expression that evaluates to the first matching DOM element or null.
   * Returns null for snapshot-based locators (ref, role, text, label, placeholder).
   */
  export function buildElementQuery(locator: BrowserLocator.LocatorInput): string | null {
    switch (locator.kind) {
      case "css":
        return `document.querySelector(${JSON.stringify(locator.value)})`
      case "xpath": {
        const escaped = locator.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        return `document.evaluate("${escaped}", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
      }
      case "testId":
        return `document.querySelector('[data-testid=${JSON.stringify(locator.value)}]')`
      default:
        return null
    }
  }

  // ── Playwright locator bridge ──────────────────────────────────────

  /**
   * Convert a Synergy LocatorInput into a Playwright Locator.
   * The caller must provide a Playwright Page (or Frame) to root the locator.
   */
  export function toPlaywrightLocator(
    page: import("playwright").Page | import("playwright").Frame,
    locator: LocatorInput,
  ): import("playwright").Locator {
    switch (locator.kind) {
      case "ref": {
        const escaped = CSS.escape(locator.value)
        return page.locator(`[ref="${escaped}"]`)
      }
      case "css":
        return page.locator(locator.value)
      case "role": {
        const opts: { name?: string | RegExp } = {}
        if (locator.name !== undefined) {
          opts.name =
            typeof locator.name === "object" ? new RegExp(locator.name.regex, locator.name.flags) : locator.name
        }
        return page.getByRole(locator.value as "button" | "checkbox" | "textbox" | "link" | "heading", opts)
      }
      case "text": {
        if (typeof locator.value === "object") {
          const pattern = new RegExp(locator.value.regex, locator.value.flags)
          return page.getByText(pattern, { exact: false })
        }
        return page.getByText(locator.value, { exact: locator.exact ?? false })
      }
      case "label": {
        if (typeof locator.value === "object") {
          const pattern = new RegExp(locator.value.regex, locator.value.flags)
          return page.getByLabel(pattern, { exact: false })
        }
        return page.getByLabel(locator.value, { exact: locator.exact ?? false })
      }
      case "placeholder": {
        if (typeof locator.value === "object") {
          const pattern = new RegExp(locator.value.regex, locator.value.flags)
          return page.getByPlaceholder(pattern, { exact: false })
        }
        return page.getByPlaceholder(locator.value, { exact: locator.exact ?? false })
      }
      case "testId":
        return page.getByTestId(locator.value)
      case "xpath":
        return page.locator(`xpath=${locator.value}`)
    }
  }
}

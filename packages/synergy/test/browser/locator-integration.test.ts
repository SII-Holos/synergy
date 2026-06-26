import { describe, test, expect, mock } from "bun:test"
import { BrowserLocator } from "../../src/browser/locator"
import { BrowserWait } from "../../src/browser/wait"
import type { BrowserTab, AccessibilityElement } from "../../src/browser/tab"
import type { CDPHandle } from "../../src/browser/cdp"

// ── helpers ──────────────────────────────────────────────────────────────

function mockTab(overrides?: Partial<BrowserTab>): BrowserTab {
  return {
    id: "tab-integration-1",
    url: "about:blank",
    title: "",
    loading: false,
    pinned: false,
    kept: false,
    lastActiveAt: null,
    cdp: null,
    navigate: mock(async () => ({ url: "", title: "" })),
    navigateForUser: mock(async () => ({ url: "", title: "" })),
    navigateWithOverride: mock(async () => ({ url: "", title: "" })),
    reload: mock(async () => {}),
    goBack: mock(async () => {}),
    goForward: mock(async () => {}),
    stop: mock(async () => {}),
    setViewport: mock(async () => {}),
    click: mock(async () => {}),
    type: mock(async () => {}),
    scroll: mock(async () => {}),
    dispatchMouse: mock(async () => {}),
    dispatchKey: mock(async () => {}),
    insertText: mock(async () => {}),
    respondToFileChooser: mock(async () => {}),
    respondToDialog: mock(async () => {}),
    ensureCDP: mock(
      async () =>
        ({
          send: mock(async () => null),
          on: mock(() => () => {}),
          detach: mock(async () => {}),
        }) as CDPHandle,
    ),
    detachCDP: mock(async () => {}),
    screenshot: mock(async () => ({ buffer: Buffer.alloc(0), width: 800, height: 600 })),
    snapshot: mock(async () => ({ elements: [], truncated: false })),
    consoleEntries: mock(async () => []),
    networkRequests: mock(async () => []),
    clearDiagnostics: mock(async () => {}),
    resolveRef: mock(async () => null),
    evaluate: mock(async () => null),
    waitFor: mock(async () => false),
    close: mock(async () => {}),
    ...overrides,
  }
}

function makeSnapshotElement(overrides?: Partial<AccessibilityElement>): AccessibilityElement {
  return {
    ref: "@e1",
    role: "button",
    name: "Click Me",
    children: [],
    ...overrides,
  }
}

function mockResolvedBox(
  x = 100,
  y = 200,
  width = 80,
  height = 30,
): { backendNodeId: number; x: number; y: number; width: number; height: number } {
  return { backendNodeId: 42, x, y, width, height }
}

// These are the locator inputs used to drive query-path assertions.
// Values chosen to be distinctive so we can identify them in expressions.
const locatorSamples = {
  ref: { kind: "ref" as const, value: "@e1" },
  role: { kind: "role" as const, value: "button" },
  roleNamed: { kind: "role" as const, value: "textbox", name: "Search" },
  text: { kind: "text" as const, value: "Submit" },
  textExact: { kind: "text" as const, value: "Submit", exact: true },
  textRegex: { kind: "text" as const, value: /submit/i },
  label: { kind: "label" as const, value: "Email" },
  placeholder: { kind: "placeholder" as const, value: "Search…" },
  testId: { kind: "testId" as const, value: "login-btn" },
  xpath: { kind: "xpath" as const, value: "//button[@id='save']" },
  css: { kind: "css" as const, value: ".submit-btn" },
}

// ═══════════════════════════════════════════════════════════════════════════
//  BrowserLocator.resolve / resolveAll — RED (not yet exported)
// ═══════════════════════════════════════════════════════════════════════════

describe("BrowserLocator.resolve (RED: public API not yet implemented)", () => {
  test("resolve is exported from BrowserLocator", () => {
    // RED: BrowserLocator.resolve does not exist yet.
    expect(typeof (BrowserLocator as any).resolve).toBe("function")
  })

  test("ref locator resolves via snapshot and resolveRef", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [makeSnapshotElement({ ref: "@e1" })],
        truncated: false,
      })),
      resolveRef: mock(async () => mockResolvedBox()),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.ref)

    expect(el).not.toBeNull()
    expect(el.visible).toBe(true)
    expect(el.x).toBe(100)
    expect(el.y).toBe(200)
  })

  test("role locator matches by role value in snapshot tree", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [makeSnapshotElement({ role: "button", ref: "@e1" })],
        truncated: false,
      })),
      resolveRef: mock(async () => mockResolvedBox()),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.role)

    expect(el).not.toBeNull()
    expect(typeof el.x).toBe("number")
  })

  test("role with name filter resolves matching element", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [makeSnapshotElement({ role: "textbox", name: "Search", ref: "@e2" })],
        truncated: false,
      })),
      resolveRef: mock(async () => mockResolvedBox(50, 50)),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.roleNamed)

    expect(el).not.toBeNull()
  })

  test("text locator matches by accessible name in snapshot tree", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [makeSnapshotElement({ name: "Submit", ref: "@e1" })],
        truncated: false,
      })),
      resolveRef: mock(async () => mockResolvedBox()),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.text)

    expect(el).not.toBeNull()
  })

  test("text locator with exact match requires full string equality", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [
          makeSnapshotElement({ name: "Submit Now", ref: "@e1" }),
          makeSnapshotElement({ name: "Submit", ref: "@e2" }),
        ],
        truncated: false,
      })),
      resolveRef: mock(async (ref: string) => (ref === "@e2" ? mockResolvedBox() : null)),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.textExact)

    expect(el).not.toBeNull()
  })

  test("text locator with RegExp pattern matches", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [makeSnapshotElement({ name: "SUBMIT", ref: "@e1" })],
        truncated: false,
      })),
      resolveRef: mock(async () => mockResolvedBox()),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.textRegex)

    expect(el).not.toBeNull()
  })

  test("label locator matches by accessible name", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [makeSnapshotElement({ name: "Email", ref: "@e1" })],
        truncated: false,
      })),
      resolveRef: mock(async () => mockResolvedBox()),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.label)

    expect(el).not.toBeNull()
  })

  test("placeholder locator matches by value property", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [makeSnapshotElement({ role: "textbox", value: "Search…", ref: "@e3" })],
        truncated: false,
      })),
      resolveRef: mock(async () => mockResolvedBox()),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.placeholder)

    expect(el).not.toBeNull()
  })

  // ── DOM-evaluated locator kinds: css, xpath, testId ──────────────

  test("testId locator evaluates data-testid query", async () => {
    const evaluateSpy = mock(async (_expr: string) => true)
    const resolveRefSpy = mock(async () => null)
    const tab = mockTab({
      snapshot: mock(async () => ({ elements: [], truncated: false })),
      evaluate: evaluateSpy,
      resolveRef: resolveRefSpy,
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>

    // Mark: the resolve call will need to evaluate to get a box — mock evaluate to return a box
    tab.evaluate = mock(async (expr: string) => {
      if (expr.includes("querySelector")) {
        if (expr.includes('[data-testid="login-btn"]')) {
          return true
        }
        return false
      }
      return { x: 0, y: 0, width: 100, height: 50 }
    })

    const el = await resolve(tab, locatorSamples.testId)

    expect(el).not.toBeNull()
    // RED: evaluate must have been called with a data-testid selector expression
    const evalCalls = (tab.evaluate as ReturnType<typeof mock>).mock?.calls ?? []
    const selectorCalls = evalCalls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("data-testid"),
    )
    expect(selectorCalls.length).toBeGreaterThan(0)
  })

  test("xpath locator evaluates XPath expression", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({ elements: [], truncated: false })),
      evaluate: mock(async (expr: string) => {
        if (expr.includes("document.evaluate")) {
          return true
        }
        if (expr.includes("getBoundingClientRect")) {
          return { x: 10, y: 20, width: 60, height: 30 }
        }
        return null
      }),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.xpath)

    expect(el).not.toBeNull()
    const evalCalls = (tab.evaluate as ReturnType<typeof mock>).mock?.calls ?? []
    const xpathCalls = evalCalls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("document.evaluate"),
    )
    expect(xpathCalls.length).toBeGreaterThan(0)
  })

  test("css locator evaluates CSS selector query", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({ elements: [], truncated: false })),
      evaluate: mock(async (expr: string) => {
        if (expr.includes("document.querySelector") && expr.includes(".submit-btn")) {
          return true
        }
        if (expr.includes("getBoundingClientRect")) {
          return { x: 0, y: 0, width: 50, height: 20 }
        }
        return null
      }),
    })
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, locatorSamples.css)

    expect(el).not.toBeNull()
    const evalCalls = (tab.evaluate as ReturnType<typeof mock>).mock?.calls ?? []
    const cssCalls = evalCalls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes(".submit-btn"),
    )
    expect(cssCalls.length).toBeGreaterThan(0)
  })

  test("returns null for unknown locator kind", async () => {
    const tab = mockTab()
    const resolve = (BrowserLocator as any).resolve as (tab: BrowserTab, locator: any) => Promise<any>
    const el = await resolve(tab, { kind: "nonexistent", value: "x" })
    expect(el).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  BrowserLocator.resolveAll — RED (not yet exported)
// ═══════════════════════════════════════════════════════════════════════════

describe("BrowserLocator.resolveAll (RED: public API not yet implemented)", () => {
  test("resolveAll is exported from BrowserLocator", () => {
    // RED: BrowserLocator.resolveAll does not exist yet.
    expect(typeof (BrowserLocator as any).resolveAll).toBe("function")
  })

  test("returns all matching role elements in snapshot tree", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [
          makeSnapshotElement({ role: "button", name: "A", ref: "@e1" }),
          makeSnapshotElement({
            role: "button",
            name: "B",
            ref: "@e2",
            children: [makeSnapshotElement({ role: "button", name: "Nested", ref: "@e3" })],
          }),
          makeSnapshotElement({ role: "link", name: "C", ref: "@e4" }),
        ],
        truncated: false,
      })),
      resolveRef: mock(async (ref: string) => {
        const idx = parseInt(ref.slice(2), 10)
        return mockResolvedBox(10 * idx, 20 * idx)
      }),
    })

    const resolveAll = (BrowserLocator as any).resolveAll as (tab: BrowserTab, locator: any) => Promise<any[]>
    const results = await resolveAll(tab, { kind: "role", value: "button" })

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(3) // A, B, Nested
  })

  test("returns all matching text locator elements", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [
          makeSnapshotElement({ name: "Save", ref: "@e1" }),
          makeSnapshotElement({ name: "Save As…", ref: "@e2" }),
          makeSnapshotElement({ name: "Cancel", ref: "@e3" }),
        ],
        truncated: false,
      })),
      resolveRef: mock(async (ref: string) => {
        const idx = parseInt(ref.slice(2), 10)
        return mockResolvedBox(10 * idx, 20 * idx)
      }),
    })

    const resolveAll = (BrowserLocator as any).resolveAll as (tab: BrowserTab, locator: any) => Promise<any[]>
    const results = await resolveAll(tab, { kind: "text", value: "Save" })

    // "Save" matches "Save" and "Save As…" (substring match by default)
    expect(results.length).toBe(2)
  })

  test("returns empty array when no elements match", async () => {
    const tab = mockTab({
      snapshot: mock(async () => ({
        elements: [makeSnapshotElement({ role: "button", name: "X" })],
        truncated: false,
      })),
      resolveRef: mock(async () => null),
    })

    const resolveAll = (BrowserLocator as any).resolveAll as (tab: BrowserTab, locator: any) => Promise<any[]>
    const results = await resolveAll(tab, { kind: "text", value: "Nonexistent" })

    expect(results).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  BrowserWait integration — RED (waitFor should delegate to resolve)
// ═══════════════════════════════════════════════════════════════════════════

describe("BrowserWait.waitForLocator integration (RED: should delegate to BrowserLocator.resolve)", () => {
  test("waitForLocator calls BrowserLocator.resolve repeatedly until element found", async () => {
    // RED: BrowserLocator.resolve doesn't exist; waitForLocator doesn't call it.
    // When resolve IS implemented, waitForLocator should call it in a polling loop.

    // We'll intercept by checking whether resolve exists first.
    // Then set up spy semantics: mock resolve to fail N times, then succeed.
    expect(typeof (BrowserLocator as any).resolve).toBe("function")

    const resolvedElement = {
      visible: true,
      enabled: true,
      editable: false,
      x: 100,
      y: 200,
      width: 80,
      height: 30,
    }

    let callCount = 0
    const originalResolve = (BrowserLocator as any).resolve
    ;(BrowserLocator as any).resolve = mock(async (_tab: BrowserTab, _loc: any) => {
      callCount++
      if (callCount < 3) return null
      return resolvedElement
    })

    try {
      const tab = mockTab() // snapshot shouldn't be used since resolve handles it
      const locator = { kind: "ref" as const, value: "@e1" }

      const promise = BrowserWait.waitForLocator(tab, locator, { timeoutMs: 1000, pollMs: 10 })
      const result = await promise

      expect(result).not.toBeNull()
      expect(result.x).toBe(100)
      // RED: resolve must have been called at least 3 times (2 nulls + 1 success)
      // Current implementation calls tryResolveLocator directly, not resolve.
      expect(callCount).toBeGreaterThanOrEqual(3)
    } finally {
      ;(BrowserLocator as any).resolve = originalResolve
    }
  })

  test("waitForLocator times out when resolve never returns an element", async () => {
    // RED: same structure — resolve is spied but current code doesn't call it.
    expect(typeof (BrowserLocator as any).resolve).toBe("function")

    const originalResolve = (BrowserLocator as any).resolve
    ;(BrowserLocator as any).resolve = mock(async () => null)

    try {
      const tab = mockTab()
      const locator = { kind: "ref" as const, value: "@e99" }

      await expect(BrowserWait.waitForLocator(tab, locator, { timeoutMs: 50, pollMs: 5 })).rejects.toThrow(/timed out/)
    } finally {
      ;(BrowserLocator as any).resolve = originalResolve
    }
  })

  test("waitForLocator respects AbortSignal", async () => {
    expect(typeof (BrowserLocator as any).resolve).toBe("function")

    const controller = new AbortController()
    const originalResolve = (BrowserLocator as any).resolve
    ;(BrowserLocator as any).resolve = mock(async () => null)

    try {
      const tab = mockTab()
      const locator = { kind: "ref" as const, value: "@e1" }

      // Abort after a short delay
      setTimeout(() => controller.abort(), 10)

      await expect(
        BrowserWait.waitForLocator(tab, locator, { signal: controller.signal, timeoutMs: 5000 }),
      ).rejects.toThrow(/Aborted/)
    } finally {
      ;(BrowserLocator as any).resolve = originalResolve
    }
  })
})

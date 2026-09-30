import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

// Reproduces the working → settled transition on the REAL SessionTurn with the
// REAL reactive store, without remounting: the compact reasoning row must flip
// from the streaming line (spinner, no button) to the persistent expandable
// row as soon as the turn settles (session status idle + terminal message).
interface SettlementHarness {
  settle: () => void
}

let dom: JSDOM
let harness: SettlementHarness

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeAll(async () => {
  const entry = await domFixture("compact-reasoning-settlement.dom")
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
  })
  const window = dom.window
  const realGetComputedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((element: Element) => {
    const style = realGetComputedStyle(element)
    Object.defineProperty(style, "animationName", { configurable: true, value: "none" })
    return style
  }) as typeof window.getComputedStyle
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0)) as unknown as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
  window.HTMLElement.prototype.scrollTo = () => {}

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    SVGElement: window.SVGElement,
    customElements: window.customElements,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: ResizeObserverStub,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })

  await import(entry)
  harness = (globalThis as typeof globalThis & { __settlementHarness: SettlementHarness }).__settlementHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
})

describe("Compact reasoning settlement transition", () => {
  test("streams as a running line and settles into a clickable row without remount", async () => {
    expect(document.querySelector('[data-component="compact-reasoning"][data-state="running"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="compact-reasoning-trigger"]')).toBeNull()
    expect(document.querySelector('[data-slot="compact-reasoning-leading"] [data-component="spinner"]')).not.toBeNull()

    harness.settle()
    await waitForUpdate()
    await waitForUpdate()

    const settled = document.querySelector('[data-component="compact-reasoning"][data-state="settled"]')
    expect(settled).not.toBeNull()
    expect(document.querySelector('[data-component="compact-reasoning"][data-state="running"]')).toBeNull()

    const trigger = document.querySelector('[data-slot="compact-reasoning-trigger"]') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('[data-slot="compact-reasoning-leading"] [data-component="spinner"]')).toBeNull()
    expect(document.querySelector('[data-slot="compact-reasoning-detail"]')).toBeNull()

    trigger.click()
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    const detail = document.querySelector('[data-slot="compact-reasoning-detail"]')
    expect(detail).not.toBeNull()
    // aria-controls points at the collapsible content root, which wraps the
    // detail region (Kobalte owns the content id).
    const controls = trigger.getAttribute("aria-controls")
    expect(controls).toBeTruthy()
    expect(document.getElementById(controls!)?.contains(detail)).toBe(true)
  })
})

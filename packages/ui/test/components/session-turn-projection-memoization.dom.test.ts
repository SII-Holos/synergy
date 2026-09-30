import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

interface ProjectionMemoizationHarness {
  setStreamText: (text: string) => void
  setSessionStatus: (status: { type: string }) => void
  getToolLookups: () => number
}

let harness: ProjectionMemoizationHarness
let dom: JSDOM

const waitUntil = async (predicate: () => boolean, timeoutMs = 3000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

beforeAll(async () => {
  const entry = await domFixture("session-turn-projection-memoization.dom")
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
  harness = (globalThis as typeof globalThis & { __projectionMemoizationHarness: ProjectionMemoizationHarness })
    .__projectionMemoizationHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
})

const doneTextRow = () => {
  const rows = document.querySelectorAll('[data-slot="session-turn-timeline-item"][data-kind="text"]')
  for (const row of rows) {
    if (row.textContent?.includes("Done answer")) return row
  }
  return null
}

describe("SessionTurn streaming projection memoization", () => {
  test("streaming deltas re-project only the streaming message", async () => {
    expect(await waitUntil(() => harness.getToolLookups() > 0)).toBe(true)
    expect(await waitUntil(() => doneTextRow() !== null)).toBe(true)

    const lookupsAfterMount = harness.getToolLookups()
    const textRow = doneTextRow()
    expect(textRow).not.toBeNull()

    harness.setStreamText("stream token a")
    expect(await waitUntil(() => harness.getToolLookups() > lookupsAfterMount, 300)).toBe(false)

    harness.setStreamText("stream token b")
    expect(await waitUntil(() => harness.getToolLookups() > lookupsAfterMount, 300)).toBe(false)

    // Deltas re-project only the streaming message: the settled message was
    // not re-projected (no new tool lookups) and its row stays mounted.
    expect(harness.getToolLookups()).toBe(lookupsAfterMount)
    expect(doneTextRow()).toBe(textRow)
  })

  test("settling re-projects the settled message once and reveals the copy action", async () => {
    expect(await waitUntil(() => harness.getToolLookups() > 0)).toBe(true)
    expect(document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="copy-markdown"]')).toBeNull()

    const lookupsBeforeSettle = harness.getToolLookups()
    harness.setSessionStatus({ type: "idle" })

    expect(await waitUntil(() => harness.getToolLookups() === lookupsBeforeSettle + 1)).toBe(true)
    expect(document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="copy-markdown"]')).not.toBeNull()
  })
})

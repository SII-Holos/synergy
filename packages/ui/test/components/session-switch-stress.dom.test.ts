import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

interface SessionSwitchStressHarness {
  replaceMessageBucket: (sessionID: string, messages: unknown[] | undefined) => void
  replacePartBucket: (messageID: string, parts: unknown[] | undefined) => void
  replacePermissionBucket: (sessionID: string, permissions: unknown[] | undefined) => void
  replaceSessionStatus: (sessionID: string, status: unknown | undefined) => void
  replaceWithFreshObjects: () => void
  replaceMessagesGrown: () => void
  clearAllBuckets: () => void
  restoreBuckets: () => void
  getErrors: () => number
}

let harness: SessionSwitchStressHarness
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
  const entry = await domFixture("session-switch-stress.dom")
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
  harness = (globalThis as typeof globalThis & { __sessionSwitchStressHarness: SessionSwitchStressHarness })
    .__sessionSwitchStressHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
})

const answerRow = () => {
  const rows = document.querySelectorAll('[data-slot="session-turn-timeline-item"][data-kind="text"]')
  for (const row of rows) {
    if (row.textContent?.includes("Stress answer")) return row
  }
  return null
}

describe("SessionTurn session-switch resilience", () => {
  test("renders the settled answer before stress mutations", async () => {
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)
    expect(harness.getErrors()).toBe(0)
  })

  test("rapid bucket replacement and clearing does not throw", async () => {
    const sid = "session-stress"
    const mid = "assistant-stress"
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)

    for (let i = 0; i < 5; i++) {
      harness.replaceMessageBucket(sid, undefined)
      harness.replacePartBucket(mid, undefined)
      harness.replacePermissionBucket(sid, undefined)
      harness.replaceSessionStatus(sid, undefined)
      await new Promise((resolve) => setTimeout(resolve, 5))
      harness.replaceWithFreshObjects()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(harness.getErrors()).toBe(0)
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)
  })

  test("whole-store clear and restore does not throw", async () => {
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)

    harness.clearAllBuckets()
    await new Promise((resolve) => setTimeout(resolve, 10))
    harness.restoreBuckets()

    expect(harness.getErrors()).toBe(0)
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)
  })

  test("projection index miss degrades to an empty array without throwing", async () => {
    // Done Criteria #3: grow the display window while clearing part buckets in
    // the same batch. latestAssistantTimelineItems recomputes from a stale
    // displayItems index during the switch, so displayItemProjections()[index]
    // must be guarded with ?.() ?? [] instead of throwing on undefined.
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)

    harness.replaceMessagesGrown()
    await new Promise((resolve) => setTimeout(resolve, 10))
    harness.restoreBuckets()

    expect(harness.getErrors()).toBe(0)
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)
  })

  test("rapid final content is still correct after repeated churn", async () => {
    for (let i = 0; i < 10; i++) {
      harness.clearAllBuckets()
      await new Promise((resolve) => setTimeout(resolve, 3))
      harness.restoreBuckets()
      await new Promise((resolve) => setTimeout(resolve, 3))
    }

    expect(harness.getErrors()).toBe(0)
    expect(await waitUntil(() => answerRow() !== null)).toBe(true)
  })
})

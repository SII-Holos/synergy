import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { domFixture } from "../support/dom-fixtures"

interface RetryHeaderHarness {
  setStatus: (status: SessionStatus) => void
  dispose: () => void
}

let dom: JSDOM
let harness: RetryHeaderHarness

const update = () => new Promise((resolve) => setTimeout(resolve, 0))
const retry = (phase: Extract<SessionStatus, { type: "retry" }>["phase"]): SessionStatus => ({
  type: "retry",
  rootID: "user-retry-header",
  messageID: "assistant-retry-header",
  phase,
  attempt: 2,
  message: "read ECONNRESET",
  error: "Error: read ECONNRESET",
  startedAt: Date.now(),
  next: phase === "waiting" ? Date.now() + 60_000 : undefined,
  canRetry: phase === "waiting",
})

beforeAll(async () => {
  const entry = await domFixture("session-turn-retry-header.dom")
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/" })
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
  harness = (globalThis as typeof globalThis & { __retryHeaderHarness: RetryHeaderHarness }).__retryHeaderHarness
}, 60_000)

afterAll(() => {
  harness?.dispose()
  dom?.window.close()
})

describe("a retry that produced no turn content still reports its phase", () => {
  const headerText = () => document.querySelector('[data-slot="turn-process-trigger"]')?.textContent ?? ""
  const cards = () => document.querySelectorAll('[data-component="error-card"]')

  test("the header names the phase the card refuses to claim", async () => {
    expect(document.querySelector('[data-component="session-turn"]')).not.toBeNull()

    harness.setStatus(retry("waiting_provider"))
    await update()
    expect(headerText()).toContain("Waiting for model connection recovery")
    expect(cards()).toHaveLength(0)

    harness.setStatus(retry("connecting"))
    await update()
    expect(headerText()).toContain("Waiting for model response")
    expect(cards()).toHaveLength(0)
  })

  test("local backoff keeps its countdown card and its attempt number", async () => {
    harness.setStatus(retry("waiting"))
    await update()
    expect(headerText()).toContain("Waiting to retry · attempt 2")
    expect(cards()).toHaveLength(1)
    expect(cards()[0]?.querySelector('[role="progressbar"]')).not.toBeNull()
  })

  test("an idle turn shows no recovery surface at all", async () => {
    harness.setStatus({ type: "idle" })
    await update()
    expect(cards()).toHaveLength(0)
  })
})

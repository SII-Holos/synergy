import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"
import type { TurnExecutionSummary } from "../../src/components/execution-completion"

interface SettlementHarness {
  settle: () => void
  reset: () => void
  stop: () => void
  clearStatus: () => void
  recoverAfterError: () => void
  setFollowing: (value: boolean) => void
  setExecutionSummary: (value: TurnExecutionSummary) => void
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

const process = () => document.querySelector('[data-slot="turn-process-trigger"]') as HTMLButtonElement
const reasoning = () => document.querySelector('[data-slot="process-reasoning-trigger"]') as HTMLButtonElement

describe("process settlement", () => {
  test("raw reasoning stays independently expandable through canonical completion", async () => {
    const row = document.querySelector('[data-component="process-reasoning"]')
    expect(process().getAttribute("aria-expanded")).toBe("true")
    expect(reasoning().getAttribute("aria-expanded")).toBe("true")
    expect(reasoning().getAttribute("aria-label")).toBe("Hide reasoning")
    expect(row?.closest('[data-slot="turn-process-meta"]')).toBeNull()
    reasoning().click()
    await waitForUpdate()
    expect(document.querySelector('[data-slot="process-reasoning-preview"]')).not.toBeNull()
    reasoning().click()
    await waitForUpdate()
    expect(document.querySelector('[data-slot="process-reasoning-detail"]')?.textContent).toContain("Thinking through")
    harness.settle()
    await waitForUpdate()
    expect(process().getAttribute("aria-expanded")).toBe("true")
    process().click()
    process().click()
    await waitForUpdate()
    expect(document.querySelector('[data-component="process-reasoning"]')).toBe(row)
    expect(reasoning().getAttribute("aria-expanded")).toBe("true")
    expect(reasoning().getAttribute("aria-label")).toBe("Hide reasoning")
    const controls = reasoning().getAttribute("aria-controls")
    expect(
      document.getElementById(controls!)?.contains(document.querySelector('[data-slot="process-reasoning-detail"]')),
    ).toBe(true)
  })
  test("completion preserves a detached reader until they return to latest", async () => {
    harness.reset()
    await waitForUpdate()
    harness.setFollowing(false)
    harness.settle()
    await waitForUpdate()
    expect(process().getAttribute("aria-expanded")).toBe("true")
    harness.setFollowing(true)
    await waitForUpdate()
    expect(process().getAttribute("aria-expanded")).toBe("false")
  })
  test("explicit expansion survives completion while following", async () => {
    harness.reset()
    await waitForUpdate()
    process().click()
    process().click()
    harness.settle()
    await waitForUpdate()
    expect(process().getAttribute("aria-expanded")).toBe("true")
  })
  test("stopped turns retain partial text and do not claim completion", async () => {
    harness.reset()
    await waitForUpdate()
    harness.stop()
    await waitForUpdate()
    expect(process().textContent).toContain("Stopped")
    expect(process().textContent).not.toContain("Completed")
    expect(document.querySelector('[data-kind="text"]')?.textContent).toContain("Here is the final answer")
    expect(document.querySelector('[data-component="error-card"]')).toBeNull()
  })
  test("an absent runtime bucket does not crash a completed turn", async () => {
    harness.reset()
    harness.settle()
    harness.clearStatus()
    await waitForUpdate()
    expect(process().textContent).toContain("Work completed")
    expect(process().textContent).not.toContain("Worked for")
  })
  test("a recovered canonical reply settles the turn after an earlier assistant failure", async () => {
    harness.recoverAfterError()
    await waitForUpdate()
    expect(process().textContent).toContain("Work completed")
    expect(process().textContent).not.toContain("Worked for")
    expect(document.querySelector('[data-component="error-card"]')).toBeNull()
    expect(document.querySelector('[data-kind="text"]')?.textContent).toContain("Here is the final answer")
    expect(document.body.textContent).toContain("Recovered answer.")
  })
  test("the process header shares the recorded execution duration and lower bound with the completion footer", async () => {
    harness.reset()
    harness.settle()
    harness.setExecutionSummary({ status: "completed", elapsedMs: 2500 })
    await waitForUpdate()
    expect(process().textContent).toContain("Worked for 2 s")
    expect(document.querySelector('[data-component="execution-completion"]')?.textContent).toContain("00:02")
    harness.setExecutionSummary({ status: "completed", elapsedMs: 0, elapsedLowerBound: true })
    await waitForUpdate()
    expect(process().textContent).toContain("≥ 0")
    expect(document.querySelector('[data-component="execution-completion"]')?.textContent).toContain("≥ 00:00")
  })
})

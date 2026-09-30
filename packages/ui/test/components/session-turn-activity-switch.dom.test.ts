import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

type ActivityDisplayMode = "full" | "balanced" | "minimal"

interface ActivitySwitchHarness {
  setMode: (mode: ActivityDisplayMode) => void
}

let dom: JSDOM
let harness: ActivitySwitchHarness

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeAll(async () => {
  const entry = await domFixture("session-turn-activity-switch.dom")
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
  harness = (globalThis as typeof globalThis & { __activitySwitchHarness: ActivitySwitchHarness })
    .__activitySwitchHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
})

describe("SessionTurn activity display switching", () => {
  test("switches minimal to full without remounting or losing timeline items", async () => {
    const turn = document.querySelector('[data-component="session-turn"]')
    const sentinel = document.querySelector("#activity-switch-sentinel")
    const answer = document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="text"]')

    expect(turn?.getAttribute("data-activity-display")).toBe("minimal")
    expect(document.querySelector('[data-component="minimal-activity-summary"]')).not.toBeNull()
    expect(answer?.textContent).toContain("Representative answer survives mode switches.")

    expect(
      document.querySelector(`[data-test-slot="message.before"][data-test-message="assistant-activity-switch-second"]`),
    ).not.toBeNull()
    expect(
      document.querySelector(
        `[data-test-slot="message.actions"][data-test-message="assistant-activity-switch-second"]`,
      ),
    ).not.toBeNull()
    expect(
      document.querySelector(`[data-test-slot="message.after"][data-test-message="assistant-activity-switch-second"]`),
    ).not.toBeNull()

    harness.setMode("balanced")
    await waitForUpdate()

    const activityGroups = document.querySelectorAll(
      '[data-slot="session-turn-timeline-item"][data-kind="activity-group"]',
    )
    const activityRows = document.querySelectorAll('[data-kind="activity-group"] [data-slot="activity-step"]')
    expect(activityGroups).toHaveLength(2)
    expect(activityRows).toHaveLength(2)
    expect(activityRows[0]?.textContent).toContain("Scholight")
    expect(activityRows[0]?.textContent).toContain("checkpoint convergence")
    expect(activityRows[1]?.textContent).toContain("Scholight Extract")
    expect(activityRows[1]?.textContent).toContain("https://example.com/paper")
    expect(document.querySelector('[data-slot="activity-trace-header"]')).toBeNull()
    expect(document.querySelector('[data-slot="activity-trace-marker"]')).toBeNull()
    expect(document.querySelector('[data-slot="activity-trace-connector"]')).toBeNull()
    expect(activityGroups[0]?.hasAttribute("data-activity-continues")).toBe(true)
    expect(activityGroups[1]?.hasAttribute("data-activity-follows")).toBe(true)

    harness.setMode("full")
    await waitForUpdate()

    expect(document.querySelector('[data-component="session-turn"]')).toBe(turn)
    expect(document.querySelector("#activity-switch-sentinel")).toBe(sentinel)
    expect(turn?.getAttribute("data-activity-display")).toBe("full")
    expect(document.querySelectorAll('[data-slot="session-turn-timeline-item"][data-kind="tool"]')).toHaveLength(2)
    expect(document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="text"]')).toBe(answer)
    expect(document.querySelectorAll('[data-slot="session-turn-timeline-item"]')).toHaveLength(4)
  })
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

let dom: JSDOM

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeAll(async () => {
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

  await import(await domFixture("session-turn-attachments-collapse.dom"))
}, 60000)

afterAll(() => {
  dom?.window.close()
})

describe("SessionTurn attachment placement", () => {
  test("renders ordinary and generated deliverables directly while the process is closed", () => {
    const items = document.querySelectorAll(
      '[data-slot="session-turn-timeline-item"]:is([data-kind="tool-attachments"], [data-kind="media"])',
    )
    expect(items.length).toBe(2)

    for (const item of items) {
      expect(!!item.querySelector('[data-component="collapsible"]')).toBe(false)
      expect(item.querySelector('[data-component="attachment-gallery"]')).toBeTruthy()
      expect(item.querySelector('[data-component="attachment-card"]')).toBeTruthy()
    }
    expect(!!document.querySelector('[data-slot="activity-evidence"]')?.closest('[hidden], [aria-hidden="true"]')).toBe(
      true,
    )
  })
  test("expanding inspection exposes compact evidence without duplicating deliverables", async () => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-slot="turn-process-trigger"]')!
    trigger.click()
    await waitForUpdate()
    document.querySelector<HTMLButtonElement>('[data-slot="activity-batch-trigger"]')?.click()
    await waitForUpdate()
    const evidence = document.querySelector('[data-slot="activity-evidence"]')!
    expect(evidence).toBeTruthy()
    expect(!!evidence.closest('[hidden], [aria-hidden="true"]')).toBe(false)
    expect(evidence.querySelector('[data-compact="process"]')?.getAttribute("title")).toBe("evidence.svg")
    expect(
      document.querySelectorAll(
        '[data-slot="session-turn-timeline-item"]:is([data-kind="tool-attachments"], [data-kind="media"])',
      ),
    ).toHaveLength(2)
    trigger.click()
    await waitForUpdate()
    expect(!!evidence.closest('[hidden], [aria-hidden="true"]')).toBe(true)
    expect(
      document.querySelectorAll(
        '[data-slot="session-turn-timeline-item"]:is([data-kind="tool-attachments"], [data-kind="media"])',
      ),
    ).toHaveLength(2)
  })
})

test("media generation retains results but removes cancelled output without a replacement row", async () => {
  const harness = (globalThis as typeof globalThis & { __mediaLifecycleHarness: { move: (status: string) => void } })
    .__mediaLifecycleHarness
  const card = document.querySelector('[data-component="media-generation-card"]')!
  expect(Boolean(card)).toBe(true)
  for (const status of ["pending", "generating", "running", "completed", "failed", "empty"]) {
    harness.move(status)
    await waitForUpdate()
    expect(document.querySelector('[data-component="media-generation-card"]') === card).toBe(true)
    const pending = ["pending", "generating", "running"].includes(status)
    expect(card.getAttribute("aria-busy")).toBe(String(pending))
    expect(Boolean(card.querySelector('[data-slot="media-generation-placeholder"]'))).toBe(pending)
    expect(Boolean(card.querySelector('[data-component="attachment-gallery"]'))).toBe(status === "completed")
    if (status === "failed") expect(card.textContent).toContain("Provider unavailable")
    if (status === "empty") expect(card.textContent).toContain("No media was returned")
  }
  harness.move("cancelled")
  await waitForUpdate()
  expect(Boolean(document.querySelector('[data-component="media-generation-card"]'))).toBe(false)
  expect(Boolean(document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="media"]'))).toBe(false)
  expect(document.body.textContent).not.toContain("Generation stopped")
  expect(
    document.querySelectorAll('[data-slot="session-turn-timeline-item"][data-kind="tool-attachments"]'),
  ).toHaveLength(1)
  harness.move("running")
  await waitForUpdate()
  expect(Boolean(document.querySelector('[data-slot="media-generation-placeholder"]'))).toBe(true)
  harness.move("completed")
  await waitForUpdate()
  expect(
    Boolean(document.querySelector('[data-component="media-generation-card"] [data-component="attachment-gallery"]')),
  ).toBe(true)
})

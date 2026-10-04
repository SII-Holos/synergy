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

describe("SessionTurn delivered attachment collapse", () => {
  test("renders hidden-card attach deliveries in a default-expanded collapsible card", async () => {
    const cards = document.querySelectorAll('[data-component="collapsible"][data-variant="tool"]')
    expect(cards.length).toBe(1)

    const attachCard = cards[0] as HTMLElement
    expect(attachCard.hasAttribute("data-expanded")).toBe(true)

    const trigger = attachCard.querySelector('[data-slot="collapsible-trigger"]') as HTMLElement
    expect(trigger?.textContent).toContain("Add attachment")
    expect(trigger?.textContent).toContain("meme.svg")

    expect(attachCard.querySelector('[data-component="attachment-gallery"]')).toBeTruthy()

    trigger.click()
    await waitForUpdate()

    expect(attachCard.hasAttribute("data-expanded")).toBe(false)
    expect(attachCard.querySelector('[data-component="attachment-gallery"]')).toBeNull()
  })

  test("renders completed media-generation deliveries as a bare inline gallery", () => {
    const items = document.querySelectorAll('[data-slot="session-turn-timeline-item"][data-kind="tool-attachments"]')
    expect(items.length).toBe(2)

    const attachItem = items[0] as HTMLElement
    expect(attachItem.querySelector('[data-component="collapsible"]')).toBeTruthy()

    const mediaItem = items[1] as HTMLElement
    expect(mediaItem.querySelector('[data-component="collapsible"]')).toBeNull()
    expect(mediaItem.querySelector('[data-slot="collapsible-trigger"]')).toBeNull()

    const gallery = mediaItem.querySelector('[data-component="attachment-gallery"]')
    expect(gallery).toBeTruthy()
    expect(mediaItem.querySelector('[data-component="attachment-card"]')).toBeTruthy()
  })
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

interface TimelineBoundaryHarness {
  setStableTick: (value: number) => void
  setExplodingTick: (value: number) => void
  setStale: (value: boolean) => void
  getProxyReads: () => number
  getThrows: () => number
}

let harness: TimelineBoundaryHarness
let dom: JSDOM

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 20))

const stableReasoningNode = () => document.querySelector('#root-stable [data-component="compact-reasoning"]')
const explodingReasoningNode = () => document.querySelector('#root-exploding [data-component="compact-reasoning"]')
const stableErrorCard = () => document.querySelector('#root-stable [data-slot="session-turn-timeline-item-error"]')
const explodingErrorCard = () =>
  document.querySelector('#root-exploding [data-slot="session-turn-timeline-item-error"]')

beforeAll(async () => {
  const entry = await domFixture("session-turn-timeline-boundary")
  // The fixture compiles a real Solid bundle through Vite before exercising
  // the lifecycle; keep this hook well above the default 5s test timeout so
  // direct `bun test` invocations do not fail on cold caches or slow disks.
  dom = new JSDOM(
    '<!doctype html><html><body><div id="root-stable"></div><div id="root-exploding"></div></body></html>',
    { url: "http://localhost/" },
  )
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

  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    customElements: window.customElements,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })

  await import(entry)
  harness = (globalThis as typeof globalThis & { __timelineBoundaryHarness: TimelineBoundaryHarness })
    .__timelineBoundaryHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
})

describe("session turn timeline item renderer boundary", () => {
  test("renders the stable reasoning row and mounts a healthy item", () => {
    expect(stableReasoningNode()?.textContent).toContain("Stable line 0")
    expect(explodingReasoningNode()).not.toBeNull()
    expect(explodingErrorCard()).toBeNull()
  })

  test("preserves timeline inner node identity across streaming ticks", async () => {
    const before = stableReasoningNode()
    expect(before?.textContent).toContain("Stable line 0")
    harness.setStableTick(1)
    await waitForUpdate()
    const after = stableReasoningNode()
    // Streaming part updates replace the display item reference on every tick;
    // the branch must stream into the mounted child instead of recreating it.
    expect(after).toBe(before)
    expect(after?.textContent).toContain("Stable line 1")
  })

  test("contains a stale timeline item read after its owner is disposed", async () => {
    harness.setStale(true)
    const throwsBefore = harness.getThrows()
    harness.setExplodingTick(1)
    await waitForUpdate()
    expect(harness.getThrows() - throwsBefore).toBeGreaterThan(0)
    expect(explodingReasoningNode()).toBeNull()
    const card = explodingErrorCard()
    expect(card).not.toBeNull()
    // The error message is contained inside the local error card.
    expect(card?.textContent).toContain("Stale read from <Switch>.")
    // The sibling stable row keeps rendering.
    expect(stableReasoningNode()?.textContent).toContain("Stable line 1")
    expect(stableErrorCard()).toBeNull()
  })
})

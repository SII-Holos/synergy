import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

let dom: JSDOM
let harness: {
  move: (stage: number) => void
  setMode: (mode: "balanced" | "full" | "minimal") => void
  setPreview: (preview: boolean) => void
  setSegmented: (value: boolean) => void
  addCompaction: (state?: "committed" | "running" | "failed") => void
  selection: () => unknown
  reset: () => void
  setExecutionState: (value: {
    rootID: string
    status: string
    startedAt: number
    endedAt: number
    stoppedAt: number[]
  }) => void
  setExecutionSummary: (
    value: { status: string; elapsedMs: number | null; elapsedLowerBound?: boolean } | undefined,
  ) => void
}

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeAll(async () => {
  const entry = await domFixture("session-turn-chronology.dom")
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
  harness = (globalThis as typeof globalThis & { __chronologyHarness: typeof harness }).__chronologyHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
})

beforeEach(async () => {
  harness.reset()
  await waitForUpdate()
})

const trigger = () => document.querySelector<HTMLButtonElement>('[data-slot="turn-process-trigger"]')!
test("reply actions complete before the interval summary and retain its authoritative duration", async () => {
  harness.move(8)
  harness.setExecutionState({
    rootID: "user-activity-switch",
    status: "completed",
    startedAt: 1,
    endedAt: 42_001,
    stoppedAt: [],
  })
  await waitForUpdate()
  const completion = document.querySelector('[data-component="execution-completion"]')!
  expect(completion).not.toBeNull()
  expect(completion.textContent).toContain("Completed")
  expect(completion.textContent).not.toContain("00:42")
  expect(document.querySelector('[data-slot="assistant-message-copy"]')).not.toBeNull()
  harness.setExecutionSummary({ status: "running", elapsedMs: 31_000 })
  await waitForUpdate()
  expect(document.querySelector('[data-component="execution-completion"]')).toBe(completion)
  expect(completion.textContent).toContain("Completed")
  expect(completion.textContent).not.toContain("00:31")
  harness.setExecutionSummary({ status: "completed", elapsedMs: 32_000, elapsedLowerBound: true })
  await waitForUpdate()
  expect(document.querySelector('[data-component="execution-completion"]')).toBe(completion)
  expect(completion.textContent).toContain("≥ 00:32")
  harness.setExecutionSummary({ status: "completed", elapsedMs: 32_000, elapsedLowerBound: false })
  await waitForUpdate()
  expect(completion.textContent).toContain("00:32")
  expect(completion.textContent).not.toContain("≥")
})

test("initial reasoning is inside the narrative before public text and later reasoning stays between tools", async () => {
  harness.move(1)
  await waitForUpdate()
  const initial = document.querySelector('[data-component="process-reasoning"]')!
  expect(initial.closest('[data-slot="turn-process-meta"]')).toBeNull()
  expect(initial.querySelector("button")?.getAttribute("aria-expanded")).toBe("true")
  expect(initial.textContent).toContain("Initial private reasoning")
  harness.move(6)
  await waitForUpdate()
  const batch = document.querySelector('[data-component="activity-batch"]')!
  const reasoning = batch.querySelector('[data-component="process-reasoning"]')!
  expect(reasoning.querySelector("button")?.getAttribute("aria-expanded")).toBe("false")
  expect(batch.querySelectorAll('[data-slot="activity-step"]')).toHaveLength(2)
  const entries = [...batch.querySelectorAll('[data-slot="activity-step"], [data-slot="activity-reasoning"]')]
  expect(entries.map((e) => e.getAttribute("data-part-id"))).toEqual(["tool-1", "later", "tool-2"])
  expect(
    document.querySelectorAll('[data-slot="turn-process-meta"] [data-component="process-reasoning"]'),
  ).toHaveLength(0)
})

test("an empty next model reply does not add a waiting row or remount the existing prose and tool", async () => {
  harness.move(3)
  await waitForUpdate()
  const prose = document.querySelector('[data-component="text-part"]')
  const tool = document.querySelector('[data-slot="activity-step"]')
  harness.move(4)
  await waitForUpdate()
  expect(document.querySelector('[data-component="provider-prelude"]')).toBeNull()
  expect(document.querySelector('[data-component="text-part"]') === prose).toBe(true)
  expect(document.querySelector('[data-slot="activity-step"]') === tool).toBe(true)
  harness.move(5)
  await waitForUpdate()
  expect(document.querySelector('[data-slot="activity-step"]') === tool).toBe(true)
})

test("reasoning disclosure choice survives streaming, completion and density changes", async () => {
  harness.move(6)
  await waitForUpdate()
  const reasoning = document.querySelector<HTMLButtonElement>('[data-slot="activity-reasoning"] button')!
  reasoning.click()
  await waitForUpdate()
  harness.move(8)
  await waitForUpdate()
  for (const mode of ["full", "minimal", "balanced"] as const) {
    harness.setMode(mode)
    await waitForUpdate()
    expect(document.querySelector('[data-slot="activity-reasoning"] button') === reasoning).toBe(true)
    expect(reasoning.getAttribute("aria-expanded")).toBe("true")
  }
  expect(trigger().getAttribute("aria-expanded")).toBe("true")
  expect(document.querySelector('[data-component="activity-batch"]')?.textContent).toContain("Ran 2 commands")
})

test("focused reasoning stays readable when the next tool arrives and releases after focus leaves", async () => {
  harness.move(5)
  await waitForUpdate()
  const entry = document.querySelector<HTMLElement>('[data-slot="activity-reasoning"]')!
  const button = entry.querySelector<HTMLButtonElement>("button")!
  button.focus()
  harness.move(6)
  await waitForUpdate()
  expect(entry.hidden).toBe(false)
  expect(entry.querySelector("button") === button).toBe(true)
  expect(document.activeElement).toBe(button)
  trigger().focus()
  await waitForUpdate()
  expect(entry.hidden).toBe(true)
})

test("reasoning preview applies to later reasoning without replacing the tool batch", async () => {
  harness.move(5)
  await waitForUpdate()
  const batch = document.querySelector('[data-component="activity-batch"]')!
  const reasoning = batch.querySelector('[data-component="process-reasoning"]')!
  expect(reasoning.querySelector('[data-slot="process-reasoning-preview"]')).toBeNull()
  harness.setPreview(true)
  await waitForUpdate()
  expect(document.querySelector('[data-component="activity-batch"]') === batch).toBe(true)
  expect(batch.querySelector('[data-component="process-reasoning"]') === reasoning).toBe(true)
  expect(reasoning.querySelector('[data-slot="process-reasoning-preview"]')?.textContent).toContain(
    "Later private reasoning",
  )
})

test("segmented turns share a single process entrance and preserve the answer when collapsed", async () => {
  harness.move(8)
  harness.setSegmented(true)
  harness.setMode("full")
  await waitForUpdate()
  expect(document.querySelectorAll('[data-slot="turn-process-meta"]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-slot="turn-process-trigger"]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-slot="activity-batch-trigger"]')).toHaveLength(2)
  const answer = document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="text"]:last-of-type')
  trigger().click()
  await waitForUpdate()
  expect(trigger().getAttribute("aria-expanded")).toBe("false")
  const visibleText = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="session-turn-timeline-item"]'),
  ).filter((element) => !element.hidden && element.style.display !== "none")
  expect(visibleText.some((element) => element.textContent?.includes("Both evidence checks passed."))).toBe(true)
  expect(document.contains(answer)).toBe(true)
})

test("a virtual process header without phase evidence uses neutral activity after narrative content arrives", async () => {
  harness.move(3)
  harness.setSegmented(true)
  await waitForUpdate()
  expect(trigger().textContent).not.toContain("Waiting for response")
  expect(trigger().textContent).not.toContain("Awaiting response")
  expect(trigger().textContent).toContain("Processing task")
})

test("segmented completed compaction renders once in its owning body without phantom running footer cards", async () => {
  harness.addCompaction()
  harness.setSegmented(true)
  await waitForUpdate()
  expect(document.querySelectorAll('[data-component="compaction-card"]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-component="compaction-card"][data-status="running"]')).toHaveLength(0)
  const card = document.querySelector('[data-component="compaction-card"]')!
  expect(card.getAttribute("data-status")).toBe("complete")
  ;(card.querySelector("button") as HTMLButtonElement).click()
  await waitForUpdate()
  expect(card.textContent).not.toContain("Durable summary")
  expect(harness.selection()).toEqual({
    kind: "compaction",
    sessionID: "session-activity-switch",
    messageID: "assistant-activity-switch",
  })
})

test.each(["running", "failed"] as const)(
  "segmented %s compaction without recovery has one lifecycle card",
  async (state) => {
    harness.addCompaction(state)
    harness.setSegmented(true)
    await waitForUpdate()
    const cards = document.querySelectorAll('[data-component="compaction-card"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].getAttribute("data-status")).toBe(state)
  },
)

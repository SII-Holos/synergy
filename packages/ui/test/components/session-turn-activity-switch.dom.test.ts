import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

type ActivityDisplayMode = "full" | "balanced" | "minimal"

interface ActivitySwitchHarness {
  setSessionPaused: (paused: boolean) => void
  setMode: (mode: ActivityDisplayMode) => void
  openedTools: { sessionID: string; messageID: string; partID: string; callID?: string }[]
  setExecutionStatus: (status: "completed" | "stopped" | "failed") => void
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
  test("all modes share the same process and preserve mounted part identity", async () => {
    const turn = document.querySelector('[data-component="session-turn"]')
    const sentinel = document.querySelector("#activity-switch-sentinel")
    const answer = document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="text"]')
    const process = document.querySelector('[data-slot="turn-process-trigger"]') as HTMLButtonElement
    const batches = Array.from(document.querySelectorAll('[data-component="activity-batch"]'))
    expect(batches).toHaveLength(1)
    expect(process.getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('[data-component="minimal-activity-summary"]')).toBeNull()
    expect(answer?.textContent).toContain("Representative answer survives mode switches.")
    for (const slot of ["message.before", "message.actions", "message.after"]) {
      expect(
        document.querySelector(`[data-test-slot="${slot}"][data-test-message="assistant-activity-switch-second"]`),
      ).not.toBeNull()
    }
    harness.setMode("full")
    await waitForUpdate()
    expect(process.getAttribute("aria-expanded")).toBe("true")
    expect(document.querySelectorAll('[data-slot="activity-step"]')).toHaveLength(3)
    process.click()
    await waitForUpdate()
    expect(process.getAttribute("aria-expanded")).toBe("false")
    for (const mode of ["balanced", "minimal", "full"] as const) {
      harness.setMode(mode)
      await waitForUpdate()
      expect(document.querySelector('[data-component="session-turn"]')).toBe(turn)
      expect(document.querySelector("#activity-switch-sentinel")).toBe(sentinel)
      expect(document.querySelector('[data-slot="session-turn-timeline-item"][data-kind="text"]')).toBe(answer)
      expect(Array.from(document.querySelectorAll('[data-component="activity-batch"]'))).toEqual(batches)
      expect(process.getAttribute("aria-expanded")).toBe("false")
    }
  })
  test("tool rows open the owned detail target without constructing an inline result", async () => {
    harness.setMode("full")
    const process = document.querySelector('[data-slot="turn-process-trigger"]') as HTMLButtonElement
    process.click()
    await waitForUpdate()
    const tool = document.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement
    tool.click()
    await waitForUpdate()
    expect(harness.openedTools).toEqual([
      {
        sessionID: "session-activity-switch",
        messageID: "assistant-activity-switch",
        partID: "tool-activity-switch",
        callID: "call-activity-switch",
      },
    ])
    expect(tool.hasAttribute("aria-expanded")).toBe(false)
    expect(document.querySelector('[data-component="tool-result-body"]')).toBeNull()
  })

  test("process metadata begins the answer without a repeated agent brand row", () => {
    const timeline = document.querySelector('[data-slot="session-turn-timeline"]')!
    expect(timeline.firstElementChild?.getAttribute("data-slot")).toBe("turn-process-meta")
    expect(document.querySelector('[data-slot="turn-agent-identity"]')).toBeNull()
  })

  test("a tool failure remains on its call without duplicating counters in process controls", async () => {
    harness.setExecutionStatus("completed")
    await waitForUpdate()
    const process = document.querySelector('[data-slot="turn-process-trigger"]')!
    const batch = document.querySelector('[data-slot="activity-batch-trigger"]')!
    expect(process.textContent).not.toContain("failed")
    expect(batch.textContent).not.toContain("failed")
    const failed = document.querySelector('[data-slot="activity-step"][data-state="error"]')!
    expect(failed.textContent).toContain("cat missing.json")
    expect(failed.querySelectorAll('[data-slot="activity-step-error"]')).toHaveLength(1)
    expect(failed.textContent).not.toContain("Failed")
    expect(failed.querySelector('[data-slot="activity-step-trigger"]')?.getAttribute("aria-label")).toContain("Failed")
  })

  test("process controls still report the canonical stopped or failed root", async () => {
    const process = document.querySelector('[data-slot="turn-process-trigger"]')!
    harness.setExecutionStatus("stopped")
    await waitForUpdate()
    expect(process.textContent?.trim()).toBe("Stopped")
    harness.setExecutionStatus("failed")
    await waitForUpdate()
    expect(process.textContent?.trim()).toBe("Execution failed")
    harness.setExecutionStatus("completed")
  })

  test("a canonical pause prevents the completion footer from advertising a stale running round", async () => {
    harness.setExecutionStatus("stopped")
    harness.setSessionPaused(true)
    await waitForUpdate()
    const footer = document.querySelector('[data-component="execution-completion"]')!
    expect(footer.textContent).toContain("Interrupted")
    expect(footer.textContent).not.toContain("Running")
    expect(footer.textContent).toContain("00:03")
    harness.setSessionPaused(false)
  })
})

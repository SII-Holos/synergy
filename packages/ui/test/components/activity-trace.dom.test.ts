import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { domFixture } from "../support/dom-fixtures"

// The fixture compiles a real Solid bundle through Vite before exercising the
// lifecycle, matching the message-part-error-boundary DOM harness. Keep this
// hook well above the default test timeout so cold caches do not fail it.
const TRANSITION_MS = 180
const TRANSITION_SETTLE_MS = TRANSITION_MS + 80

interface ActivityDomHarness {
  setFeatures(features: string[] | undefined): void
  setLatePartsLoaded(loaded: boolean): void
  setSessionPaused: (paused: boolean) => void
  setBatchPending: (count: number) => void
  setBatchLive: (live: boolean) => void
  setApproval: (enabled: boolean) => void
  getPermissionCalls: () => unknown[]
  finishPermission: (failed: boolean) => void
  resetCount: (identity: string, value: number) => void
  setCountValue: (value: number) => void
  setSummaryCompleted: (completed: boolean) => void
  setRailState: (state: "running" | "done") => void
  refreshActivityGroup: () => void
  getNavigateCalls: () => string[]
}

let dom: JSDOM
let harness: ActivityDomHarness

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function rendered(selector: string) {
  const deadline = Date.now() + 2000
  while (!document.querySelector(selector) && Date.now() < deadline) await wait(5)
  expect(document.querySelector(selector)).not.toBeNull()
}
const reducedMotion = { current: false }

test("partial patches show only observed diffs and keep operation details out of the result", async () => {
  for (const outcome of ["partial", "unresolved"]) {
    await rendered(`#patch-${outcome} [data-component="tool-patch-preview"]`)
    const host = document.getElementById(`patch-${outcome}`)!
    expect(host.textContent).toContain("source.ts")
    expect(host.textContent).not.toContain("destination.ts")
    expect(host.textContent).not.toContain("move failed")
    expect(host.textContent).not.toContain("move unconfirmed")
    expect(host.querySelector("[data-phase]")).toBeNull()
    expect(host.textContent).not.toContain("later.ts")
    expect(host.textContent).not.toContain("Not created")
    expect(host.textContent).not.toContain("@@")
    expect(host.textContent).not.toContain("Stopped after a committed write")
    expect(host.querySelector('[data-component="tool-output-text"]')).toBeNull()
    expect(host.textContent).not.toContain("Raw patch ledger")
    expect(host.textContent).not.toContain("Committed")
  }
})

test("successful patches present one result without repeating the model output", async () => {
  await rendered('#patch-applied [data-component="tool-patch-preview"]')
  const host = document.getElementById("patch-applied")!
  expect(host.textContent).toContain("added.ts")
  expect(host.textContent).not.toContain("Created")
  expect(host.textContent).not.toContain("@@")
  expect(host.querySelector('[data-component="diff-patch"]')).not.toBeNull()
  expect(host.querySelector('[data-component="tool-output-text"]')).toBeNull()
  expect(host.textContent).not.toContain("Patch applied.")
})

function patchPreviews(host: Element) {
  return Array.from(host.querySelectorAll('[data-component="tool-patch-preview"]'), (preview) => ({
    path: preview.querySelector('[data-slot="tool-patch-path"]')?.textContent?.replaceAll("\u200e", ""),
    rows: Array.from(preview.querySelectorAll('[data-slot="tool-patch-line"]'), (row) => ({
      kind: row.getAttribute("data-kind"),
      text: row.querySelector("code")?.textContent,
    })),
  }))
}

test("successful Moves render exactly the recorded destination replacement and source deletion", async () => {
  await rendered('#patch-move-applied [data-slot="tool-patch-line"]')
  const host = document.getElementById("patch-move-applied")!
  expect(host.querySelectorAll('[data-component="diff-patch"]')).toHaveLength(2)
  expect(patchPreviews(host)).toEqual([
    {
      path: "nested/destination.ts",
      rows: [
        { kind: "delete", text: 'export const destination = "before";' },
        { kind: "add", text: 'export const moved = "after";' },
      ],
    },
    {
      path: "source.ts",
      rows: [{ kind: "delete", text: 'export const moved = "before";' }],
    },
  ])
})

test("partial Moves with failed source removal render only the recorded destination diff", async () => {
  await rendered('#patch-move-partial [data-slot="tool-patch-line"]')
  const host = document.getElementById("patch-move-partial")!
  expect(patchPreviews(host)).toEqual([
    {
      path: "nested/destination.ts",
      rows: [
        { kind: "delete", text: 'export const destination = "before";' },
        { kind: "add", text: 'export const moved = "after";' },
      ],
    },
  ])
  expect(host.textContent).not.toContain("source.ts")
  expect(host.textContent).not.toContain('export const moved = "before";')
})

test("unconfirmed Moves with authoritative empty files suppress legacy diff and observedPath previews", async () => {
  await rendered('#patch-move-unresolved [data-component="patch-result"]')
  const host = document.getElementById("patch-move-unresolved")!
  expect(patchPreviews(host)).toEqual([])
  expect(host.querySelector('[data-component="diff-patch"]')).toBeNull()
  expect(host.textContent).not.toContain("source.ts")
  expect(host.textContent).not.toContain("destination.ts")
  expect(host.textContent).not.toContain('export const moved = "before";')
})

test("edit and multi-file revise results share file diff cards without operation summaries", async () => {
  for (const tool of ["edit", "revise_file"]) {
    await rendered(`#result-${tool} [data-component="tool-patch-preview"]`)
    const host = document.getElementById(`result-${tool}`)!
    expect(host.querySelectorAll('[data-component="tool-patch-preview"]').length).toBe(tool === "edit" ? 1 : 2)
    expect(host.textContent).toContain("example.ts")
    expect(host.textContent).not.toContain("@@")
    expect(host.textContent).not.toContain("SWAP")
    expect(host.textContent).not.toContain("private diagnostic")
    expect(host.querySelector('[data-component="diff-patch"]')).not.toBeNull()
  }
})

function countRoot(): HTMLElement {
  return document.querySelector('#count-host [data-component="animated-activity-count"]') as HTMLElement
}

function countSlot(slot: string): Element | null {
  return document.querySelector(`#count-host [data-slot="${slot}"]`)
}

function countOldSlots(): NodeListOf<Element> {
  return document.querySelectorAll('#count-host [data-slot="activity-count-old"]')
}

beforeAll(async () => {
  const entry = await domFixture("activity-trace.dom")
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
  })
  const window = dom.window
  // JSDOM reports animationName as "" instead of "none"; normalize it so
  // solid-presence treats unanimated content as settled and unmounts it.
  const realGetComputedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((element: Element) => {
    const style = realGetComputedStyle(element)
    Object.defineProperty(style, "animationName", { configurable: true, value: "none" })
    return style
  }) as typeof window.getComputedStyle
  window.matchMedia = ((query: string) => ({
    matches: reducedMotion.current,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLHeadElement: window.HTMLHeadElement,
    SVGElement: window.SVGElement,
    customElements: window.customElements,
    CSSStyleSheet: window.CSSStyleSheet,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })

  await import(entry)
  harness = (globalThis as unknown as { __activityDomHarness: ActivityDomHarness }).__activityDomHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
})

function closeResult() {
  document.querySelector<HTMLButtonElement>('[role="dialog"] [data-slot="dialog-close-button"]')?.click()
}

describe("AnimatedActivityCount DOM behavior", () => {
  test("canonical pause stops stale tool animation and resuming restores the recorded running state", async () => {
    const selector = '#activity-rail-host [data-slot="activity-step"][data-state="running"]'
    const step = document.querySelector(selector)!
    expect(step).not.toBeNull()
    harness.setSessionPaused(true)
    await wait(0)
    expect(step.querySelector('[data-component="spinner"]')).toBeNull()
    expect(step.textContent).toContain("Paused")
    expect(step.hasAttribute("data-working")).toBe(false)
    harness.setSessionPaused(false)
    await wait(0)
    expect(document.querySelector(selector)).toBe(step)
    expect(step.querySelector('[data-component="spinner"]')).not.toBeNull()
  })
  test("a visible pending total survives facts catching up across activity phases", async () => {
    harness.resetCount("pending-total", 24)
    harness.setBatchLive(false)
    harness.setBatchPending(1)
    await wait(20)
    const total = document.querySelector('#batch-count-host [data-activity-fact="total"]')
    expect(total).not.toBeNull()
    harness.setCountValue(25)
    harness.setBatchPending(0)
    harness.setBatchLive(true)
    await wait(20)
    expect(document.querySelector('#batch-count-host [data-activity-fact="total"]')).toBe(total)
    expect(total?.textContent).toContain("25")
    harness.resetCount("after-pending", 9)
  })
  test("first mount snaps to the initial value without a transition", () => {
    expect(countSlot("activity-count-new")?.textContent).toBe("9")
    expect(countSlot("activity-count-old")).toBeNull()
    expect(countRoot().hasAttribute("data-animating")).toBe(false)
    expect(countRoot().getAttribute("aria-label")).toBe("9")
  })

  test.each([
    [9, 10],
    [20, 21],
    [24, 25],
    [99, 100],
  ])("%i to %i keeps exactly one old/new transition then settles", async (before, after) => {
    harness.resetCount(`trans-${after}`, before)
    await wait(0)
    expect(countSlot("activity-count-new")?.textContent).toBe(String(before))
    expect(countRoot().hasAttribute("data-animating")).toBe(false)

    harness.setCountValue(after)
    await wait(0)
    expect(countRoot().hasAttribute("data-animating")).toBe(true)
    expect(countSlot("activity-count-old")?.textContent).toBe(String(before))
    expect(countSlot("activity-count-new")?.textContent).toBe(String(after))
    expect(countOldSlots()).toHaveLength(1)
    expect(countRoot().getAttribute("aria-label")).toBe(String(after))

    await wait(TRANSITION_SETTLE_MS)
    expect(countRoot().hasAttribute("data-animating")).toBe(false)
    expect(countSlot("activity-count-old")).toBeNull()
    expect(countSlot("activity-count-new")?.textContent).toBe(String(after))
  })

  test("rapid updates cancel the stale transition and keep one old/new pair", async () => {
    harness.resetCount("rapid-a", 9)
    await wait(0)
    harness.setCountValue(10)
    await wait(0)
    harness.setCountValue(12)
    await wait(0)

    expect(countRoot().hasAttribute("data-animating")).toBe(true)
    expect(countSlot("activity-count-old")?.textContent).toBe("10")
    expect(countSlot("activity-count-new")?.textContent).toBe("12")
    expect(countOldSlots()).toHaveLength(1)
    expect(document.querySelectorAll('#count-host [data-slot="activity-count-new"]')).toHaveLength(1)

    await wait(TRANSITION_SETTLE_MS)
    expect(countRoot().hasAttribute("data-animating")).toBe(false)
    expect(countSlot("activity-count-old")).toBeNull()
    expect(countSlot("activity-count-new")?.textContent).toBe("12")
  })

  test("batch labels retain the numeric node while its value and plural grammar change", async () => {
    harness.resetCount("batch", 1)
    await wait(0)
    const number = document.querySelector('#batch-count-host [data-component="animated-activity-count"]')
    expect(number).not.toBeNull()
    expect(document.querySelector("#batch-count-host")?.textContent).toContain("command")
    harness.setCountValue(2)
    await wait(0)
    expect(document.querySelector('#batch-count-host [data-component="animated-activity-count"]')).toBe(number)
    expect(number?.hasAttribute("data-animating")).toBe(true)
    await wait(TRANSITION_SETTLE_MS)
    expect(document.querySelector("#batch-count-host")?.textContent).toBe("Ran 2 commands")
  })

  test("unrelated projection updates cannot restart an unchanged count transition", async () => {
    harness.resetCount("stable-count-timer", 9)
    await wait(0)
    harness.setCountValue(10)
    await wait(100)
    harness.setBatchPending(1)
    await wait(120)
    const number = document.querySelector(
      '#batch-count-host [data-activity-fact="execute"] [data-component="animated-activity-count"]',
    )!
    expect(number.hasAttribute("data-animating")).toBe(false)
    expect(number.getAttribute("aria-label")).toBe("10")
    harness.setBatchPending(0)
  })

  test("decrease and identity reset snap without a transition", async () => {
    harness.resetCount("snap-dec", 20)
    await wait(0)
    harness.setCountValue(8)
    await wait(0)
    expect(countRoot().hasAttribute("data-animating")).toBe(false)
    expect(countSlot("activity-count-old")).toBeNull()
    expect(countSlot("activity-count-new")?.textContent).toBe("8")

    harness.resetCount("snap-identity", 21)
    await wait(0)
    expect(countRoot().hasAttribute("data-animating")).toBe(false)
    expect(countSlot("activity-count-old")).toBeNull()
    expect(countSlot("activity-count-new")?.textContent).toBe("21")
  })

  test("prefers-reduced-motion replaces directly instead of animating", async () => {
    reducedMotion.current = true
    try {
      harness.resetCount("motion-a", 99)
      await wait(0)
      harness.setCountValue(100)
      await wait(0)
      expect(countRoot().hasAttribute("data-animating")).toBe(false)
      expect(countSlot("activity-count-old")).toBeNull()
      expect(countSlot("activity-count-new")?.textContent).toBe("100")
      expect(countRoot().getAttribute("aria-label")).toBe("100")
    } finally {
      reducedMotion.current = false
    }
  })

  test("keeps the aria label on the latest value through and after the transition", async () => {
    harness.resetCount("aria-a", 9)
    await wait(0)
    harness.setCountValue(10)
    await wait(0)
    expect(countRoot().getAttribute("aria-label")).toBe("10")
    await wait(TRANSITION_SETTLE_MS)
    expect(countRoot().getAttribute("aria-label")).toBe("10")
    expect(countSlot("activity-count-new")?.textContent).toBe("10")
  })
})

describe("MinimalActivitySummary DOM behavior", () => {
  function summaryRoot(): HTMLElement {
    return document.querySelector('[data-component="minimal-activity-summary"]') as HTMLElement
  }

  test("announces politely only after completion", async () => {
    expect(summaryRoot().hasAttribute("role")).toBe(false)
    expect(summaryRoot().getAttribute("aria-live")).toBe("off")
    expect(summaryRoot().getAttribute("aria-label")).toBe("9 actions · changed 3")

    harness.setSummaryCompleted(true)
    await wait(0)
    expect(summaryRoot().getAttribute("role")).toBe("status")
    expect(summaryRoot().getAttribute("aria-live")).toBe("polite")
    expect(summaryRoot().getAttribute("aria-label")).toBe("9 actions · changed 3")

    harness.setSummaryCompleted(false)
    await wait(0)
    expect(summaryRoot().hasAttribute("role")).toBe(false)
    expect(summaryRoot().getAttribute("aria-live")).toBe("off")
  })
})

describe("Activity summary DOM behavior", () => {
  function reasoning(state: string): HTMLElement {
    return document.querySelector(`[data-component="reasoning-summary"][data-summary-state="${state}"]`) as HTMLElement
  }

  test("keeps pending and live updates silent while announcing terminal summaries", () => {
    expect(reasoning("pending").textContent).toContain("Thinking…")
    expect(reasoning("pending").querySelector('[data-component="spinner"]')).not.toBeNull()
    expect(reasoning("pending").getAttribute("aria-live")).toBe("off")
    expect(reasoning("pending").hasAttribute("role")).toBe(false)

    expect(reasoning("live").textContent).toContain("Tracing the message flow")
    expect(reasoning("live").getAttribute("aria-live")).toBe("off")
    expect(reasoning("live").hasAttribute("role")).toBe(false)

    expect(reasoning("stable").textContent).toContain("Mapped the message flow")
    expect(reasoning("stable").getAttribute("data-summary-source")).toBe("nano")
    expect(reasoning("stable").getAttribute("role")).toBe("status")
    expect(reasoning("stable").getAttribute("aria-live")).toBe("polite")

    expect(reasoning("fallback").textContent).toContain("Reasoning")
    expect(reasoning("fallback").querySelector('[data-component="spinner"]')).toBeNull()
    expect(reasoning("fallback").getAttribute("role")).toBe("status")
    expect(reasoning("fallback").getAttribute("aria-live")).toBe("polite")
  })

  test("renders minimal summaries without a nano topic parent row", () => {
    expect(document.querySelector('#activity-main-host [data-slot="activity-trace-title"]')).toBeNull()
    const now = document.querySelector('[data-slot="minimal-activity-now"]')
    expect(now).toBeNull()
  })
})

describe("ActivityTrace DOM behavior", () => {
  function stepTriggers(host = document): NodeListOf<HTMLButtonElement> {
    return host.querySelectorAll('[data-slot="activity-step-trigger"]')
  }

  test("renders heterogeneous tool rows without outer group chrome", () => {
    const host = document.querySelector("#activity-main-host") as HTMLElement
    const list = host.querySelector('[data-slot="activity-step-list"]')
    const steps = list?.querySelectorAll('[data-slot="activity-step"]')

    expect(host.querySelector('[data-slot="activity-trace-header"]')).toBeNull()
    expect(host.querySelector('[data-slot="activity-trace-marker"]')).toBeNull()
    expect(host.querySelector('[data-slot="activity-trace-connector"]')).toBeNull()
    expect(host.querySelector('[data-slot="activity-trace-title"]')).toBeNull()
    expect(list).not.toBeNull()
    expect(steps).toHaveLength(2)
    expect(Array.from(steps ?? []).map((step) => step.getAttribute("data-family"))).toEqual([
      "modify-files",
      "research-web",
    ])
    expect(
      Array.from(list?.querySelectorAll('[data-slot="activity-step-family"]') ?? []).map((item) => item.textContent),
    ).toEqual([])
    expect(list?.querySelector('[data-slot="activity-step-branch"]')).toBeNull()
  })

  test("exposes the full step title to hover when narrow layouts truncate it", () => {
    const title = document.querySelector('#activity-main-host [data-slot="activity-step-title"]')
    expect(title?.textContent).toBe("Edit activity-trace")
    expect(title?.getAttribute("title")).toBe("Edit activity-trace")
  })

  test("keeps the action and object together without repeating the object", () => {
    const subtitle = document.querySelector('#error-host [data-slot="activity-step-title"]')
    expect(subtitle?.textContent).toBe("Run build.sh")
    expect(subtitle?.getAttribute("title")).toBe("Run build.sh")
  })

  test("tool rows select a result without disclosure semantics", async () => {
    const triggers = stepTriggers()
    expect(triggers).toHaveLength(9)
    expect(triggers[0]?.tagName).toBe("BUTTON")
    expect(triggers[0]?.getAttribute("type")).toBe("button")
    expect(triggers[0]?.hasAttribute("aria-expanded")).toBe(false)
    expect(triggers[0]?.closest('[data-component="collapsible"]')).toBeNull()
  })

  test("renders the waiting approval state once within its child activity", () => {
    const waitingStep = document.querySelector('[data-slot="activity-step"][data-state="waiting-approval"]')
    expect(waitingStep?.querySelectorAll('[data-slot="activity-state"]')).toHaveLength(1)
    expect(waitingStep?.textContent?.match(/Waiting for approval/g)).toHaveLength(1)
  })

  test("renders the file diff leaf component when its child activity expands", async () => {
    const firstTrigger = document.querySelector(
      '#activity-main-host [data-slot="activity-step-trigger"]',
    ) as HTMLButtonElement
    firstTrigger.click()
    await wait(0)

    const fileStep = document.querySelector('[role="dialog"]')
    expect(fileStep?.querySelector('[data-component="tool-patch-preview"]')).not.toBeNull()

    closeResult()
    await wait(0)
  })
  test("updates flat tool state without rendering a progress rail or checkbox", async () => {
    const rail = document.querySelector("#activity-rail-host") as HTMLElement
    const traces = rail.querySelectorAll('[data-component="activity-trace"]')
    expect(traces).toHaveLength(2)

    const first = traces[0] as HTMLElement
    const firstStep = first.querySelector('[data-slot="activity-step"]') as HTMLElement
    expect(first.querySelector('[data-slot="activity-trace-header"]')).toBeNull()
    expect(first.querySelector('[data-slot="activity-trace-marker"]')).toBeNull()
    expect(first.querySelector('[data-slot="activity-trace-connector"]')).toBeNull()
    expect(firstStep.getAttribute("data-state")).toBe("running")
    expect(firstStep.textContent).toContain("Running")

    harness.setRailState("done")
    await wait(0)

    const updatedStep = rail.querySelector(
      '[data-component="activity-trace"] [data-slot="activity-step"]',
    ) as HTMLElement
    expect(updatedStep.getAttribute("data-state")).toBe("done")
    expect(updatedStep.querySelector('[data-slot="activity-state"]')).toBeNull()
  })

  test("renders view_file through the Full-mode renderer body without a nested tool card", async () => {
    const viewHost = document.querySelector("#view-file-host") as HTMLElement
    const viewTrigger = viewHost.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement
    viewTrigger.click()
    await wait(0)

    const result = document.querySelector('[role="dialog"]')!
    expect(result.querySelector('[data-component="tool-result-body"]')).not.toBeNull()
    expect(result.querySelector('[data-component="anchored-summary"]')).not.toBeNull()
    expect(result.querySelector('[data-component="tool-content-preview"]')).not.toBeNull()
    expect(result.querySelector('[data-component="code-fixture"]')).toBeNull()
    expect(result.querySelector('[data-component="tool-output-text"]')?.textContent).toBe("const parity = true")
    expect(result.querySelector('[data-component="collapsible"][data-variant="tool"]')).toBeNull()
    closeResult()
    await wait(0)
  })

  test("keeps a failed tool as a selection and displays its error without parameter disclosure", async () => {
    const host = document.querySelector("#error-host") as HTMLElement
    const trigger = host.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement
    expect(trigger.hasAttribute("aria-expanded")).toBe(false)
    expect(host.querySelector('[data-component="error-card"]')).toBeNull()
    expect(trigger.querySelector('[data-slot="activity-state"]')).toBeNull()
    expect(trigger.getAttribute("aria-label")).toContain("Failed")

    trigger.click()
    await wait(0)

    expect(trigger.hasAttribute("aria-expanded")).toBe(false)
    const result = document.querySelector('[role="dialog"]')!
    expect(result.querySelector('[data-component="error-card"]')).toBeNull()
    expect(result.querySelector('[data-slot="tool-result-error"][role="status"]')).not.toBeNull()
    expect(result.querySelector('[data-component="collapsible"]')).toBeNull()
    expect(result.textContent).not.toContain("Tool input")
    expect(result.textContent).toContain("command not found")
    expect(result.textContent).toContain("exit code 127")
    closeResult()
    await wait(0)
  })

  test("renders the approval audit icon for an auto-allowed step", () => {
    const host = document.querySelector("#error-host") as HTMLElement
    const audit = host.querySelector('[data-component="tool-audit-icon"]')
    expect(audit).not.toBeNull()
    expect(audit?.querySelector('[data-slot="icon-svg"]')).not.toBeNull()
  })
})

describe("Delegated subagent activity DOM behavior", () => {
  test("expands a delegate step into the subagent detail with steps and an open-session action", async () => {
    const host = document.querySelector("#delegate-host") as HTMLElement
    const trigger = host.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement
    trigger.click()
    await wait(0)

    expect(trigger.hasAttribute("aria-expanded")).toBe(false)
    const result = document.querySelector('[role="dialog"]')!
    expect(
      result.querySelector('[data-component="tool-output"] > [data-component="task-subagent-detail"]'),
    ).not.toBeNull()
    expect(result.querySelector('[data-slot="task-subagent-agent"]')?.textContent).toBe("explore")
    expect(result.querySelector('[data-slot="task-subagent-description"]')?.textContent).toBe("Inspect the registry")
    expect(result.querySelectorAll('[data-slot="task-tool-item"]')).toHaveLength(3)
    expect(
      result.querySelector('[data-slot="task-tool-item"][data-state="running"] [data-slot="task-tool-status"]'),
    ).not.toBeNull()

    const open = result.querySelector('[data-slot="task-subagent-open"]') as HTMLButtonElement
    expect(open?.tagName).toBe("BUTTON")
    open?.click()
    await wait(0)
    expect(harness.getNavigateCalls()).toEqual(["child-1"])

    closeResult()
    await wait(0)
  })

  test("shows the background delegation state in the header instead of a blank expansion", async () => {
    const host = document.querySelector("#delegate-bg-host") as HTMLElement
    const trigger = host.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement
    trigger.click()
    await wait(0)
    const result = document.querySelector('[role="dialog"]')!

    expect(
      result.querySelector('[data-component="tool-output"] > [data-component="task-subagent-detail"]'),
    ).not.toBeNull()
    expect(result.querySelector('[data-slot="task-subagent-agent"]')?.textContent).toBe("explore")
    expect(result.querySelector('[data-slot="task-subagent-mode"]')?.textContent).toBe("background")
    const state = result.querySelector('[data-slot="task-subagent-state"]') as HTMLElement
    expect(state?.textContent).toContain("Running")
    expect(result.querySelector('[data-slot="task-subagent-state-dot"]')).not.toBeNull()
    expect(result.querySelector('[data-slot="task-subagent-empty"]')).toBeNull()
    expect(result.querySelector('[data-slot="task-subagent-open"]')).not.toBeNull()
    expect(result.querySelectorAll('[data-slot="task-tool-item"]')).toHaveLength(0)
    closeResult()
    await wait(0)
  })
})

describe("ActivityReceipt DOM behavior", () => {
  function trigger(): HTMLButtonElement {
    return document.querySelector('#dag-receipt-host [data-slot="activity-receipt-trigger"]') as HTMLButtonElement
  }

  test("expands a DAG receipt into the DAG graph leaf component", async () => {
    expect(trigger().tagName).toBe("BUTTON")
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('#dag-receipt-host [data-component="dag-graph"]')).toBeNull()

    trigger().click()
    await rendered('#dag-receipt-host [data-component="dag-graph"]')

    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    expect(document.querySelector('#dag-receipt-host [data-component="dag-graph"]')).not.toBeNull()
  })

  test("exposes the full receipt title to hover when narrow layouts truncate it", () => {
    const title = document.querySelector('#dag-receipt-host [data-slot="activity-receipt-title"]')
    expect(title?.textContent).toBe("Read DAG")
    expect(title?.getAttribute("title")).toBe("Read DAG")
  })

  test("exposes the full receipt scope to hover when narrow layouts truncate it", () => {
    const scope = document.querySelector('#dag-receipt-host [data-slot="activity-receipt-scope"]')
    expect(scope?.textContent).toBe("DAG snapshot")
    expect(scope?.getAttribute("title")).toBe("DAG snapshot")
  })

  test("expands a failed task receipt into the subagent detail with its error", async () => {
    const host = document.querySelector("#task-receipt-host") as HTMLElement
    const receiptTrigger = host.querySelector('[data-slot="activity-receipt-trigger"]') as HTMLButtonElement
    expect(receiptTrigger).not.toBeNull()
    expect(receiptTrigger.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector('[data-component="task-subagent-detail"]')).toBeNull()

    receiptTrigger.click()
    await rendered('#task-receipt-host [data-component="task-subagent-detail"]')

    expect(receiptTrigger.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector('[data-component="task-subagent-detail"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="task-subagent-error"]')?.textContent).toBe(
      "Agent type scout is not visible to synergy",
    )
    expect(host.querySelector('[data-slot="task-subagent-empty"]')).toBeNull()
    expect(host.querySelectorAll('[data-slot="task-tool-item"]')).toHaveLength(0)
  })
})

test("inline approval locks duplicate clicks and keeps a failed response retryable", async () => {
  harness.setApproval(true)
  await wait(0)
  const approve = document.querySelector('[data-slot="activity-approval-actions"] button') as HTMLButtonElement
  expect(approve).not.toBeNull()
  const before = harness.getPermissionCalls().length
  approve.click()
  approve.click()
  await wait(0)
  expect(harness.getPermissionCalls()).toHaveLength(before + 1)
  expect(approve.disabled).toBe(true)
  harness.finishPermission(true)
  await wait(0)
  expect(document.querySelector('[data-slot="activity-approval-actions"] [role="alert"]')?.textContent).toContain(
    "Approval unavailable",
  )
  expect(approve.disabled).toBe(false)
  approve.click()
  await wait(0)
  expect(harness.getPermissionCalls()).toHaveLength(before + 2)
  harness.finishPermission(false)
  harness.setApproval(false)
  await wait(0)
})

test("removing a tool capability replaces its historical card with retained generic output", async () => {
  const selector = '#optional-tool-host [data-component="tool-object-result"]'
  expect(document.querySelector(selector)).toBeNull()
  harness.setFeatures(undefined)
  await rendered(selector)
  expect(document.querySelector("#optional-tool-host")?.textContent).toContain("Retained historical note text")
  expect(document.querySelector("#optional-tool-host")?.textContent).not.toContain("Created")
  expect(document.querySelector("#optional-structured-tool-host")?.textContent).not.toContain("hidden-control-id")
  harness.setFeatures([])
  await wait(0)
  expect(document.querySelector(selector)).not.toBeNull()
  harness.setFeatures(["note"])
  await wait(0)
  expect(document.querySelector(selector)).toBeNull()
})

test("special workflow bubbles admit late attachment content and preserve it when their source disappears", async () => {
  const hosts = ["late-blueprint-start", "late-workflow-request", "late-workflow-control"]
  harness.setFeatures(["blueprint", "lattice"])
  await wait(0)
  for (const id of hosts) expect(document.getElementById(id)?.textContent).not.toContain("retained-request.txt")
  harness.setLatePartsLoaded(true)
  await wait(0)
  for (const id of hosts) expect(document.getElementById(id)?.textContent).toContain("retained-request.txt")
  for (const features of [undefined, ["blueprint"], ["blueprint", "lattice"]]) {
    harness.setFeatures(features)
    await wait(0)
    for (const id of hosts) expect(document.getElementById(id)?.textContent).toContain("retained-request.txt")
  }
  harness.setFeatures(["note"])
})

test("missing workflow owners hide historical badges and control messages while preserving user requests", async () => {
  harness.setFeatures(["blueprint"])
  await wait(0)
  expect(document.querySelector('#optional-workflow-request [data-slot="special-message-badge"]')).not.toBeNull()
  expect(document.querySelector('#optional-blueprint-control [data-component="special-user-message"]')).not.toBeNull()
  harness.setFeatures([])
  await wait(0)
  expect(document.querySelector('#optional-workflow-request [data-slot="special-message-badge"]')).toBeNull()
  expect(document.querySelector("#optional-workflow-request")?.textContent).toContain("Keep my original request")
  expect(document.querySelector("#optional-blueprint-control")?.textContent).toBe("")
  expect(document.querySelector("#optional-blueprint-start")?.textContent).toContain("Keep my Blueprint request")
  expect(document.querySelector("#optional-blueprint-start")?.textContent).not.toContain("Internal Blueprint")
  harness.setFeatures(["note"])
})

test("removed tool owners hide timeline controls and keep only their ordinary output", async () => {
  harness.setFeatures(["note"])
  await wait(0)
  expect(document.querySelector('#optional-trace-host [data-slot="activity-step-trigger"]')).not.toBeNull()
  harness.setFeatures([])
  await wait(0)
  expect(document.querySelector('#optional-trace-host [data-slot="activity-step-trigger"]')).toBeNull()
  expect(document.querySelector("#optional-trace-host")?.textContent).not.toContain("Created private Note")
  expect(document.querySelector("#optional-trace-host")?.textContent).toContain("Retained timeline output")
  harness.setFeatures(["note"])
})

test("removing a Blueprint source hides its historical controls while preserving the request and sent attachments", async () => {
  harness.setFeatures(["blueprint", "lattice"])
  await rendered('#source-blueprint-control [data-component="special-user-message"]')
  expect(document.querySelector('#source-blueprint-start [data-slot="special-message-badge"]')).not.toBeNull()
  expect(document.querySelector("#source-blueprint-start")?.textContent).toContain("retained-request.txt")
  for (const features of [["blueprint"], undefined, ["lattice"]]) {
    harness.setFeatures(features)
    await wait(0)
    expect(document.querySelector("#source-blueprint-control")?.textContent).toBe("")
    expect(document.querySelector('#source-blueprint-start [data-slot="special-message-badge"]')).toBeNull()
    expect(document.querySelector("#source-blueprint-start")?.textContent).toContain("Keep my Blueprint request")
    expect(document.querySelector("#source-blueprint-start")?.textContent).toContain("retained-request.txt")
    expect(document.querySelector("#source-blueprint-tool")?.textContent).not.toContain("source-control-id")
    expect(document.querySelector("#source-blueprint-tool")?.textContent).not.toContain("Lattice Blueprint approved")
    expect(document.querySelector("#source-blueprint-tool")?.textContent).toContain("retained-request.txt")
  }
  harness.setFeatures(["blueprint"])
  await wait(0)
  expect(document.querySelector('#optional-blueprint-control [data-component="special-user-message"]')).not.toBeNull()
  harness.setFeatures(["blueprint", "lattice"])
  await rendered('#source-blueprint-control [data-component="special-user-message"]')
  expect(document.querySelector("#source-blueprint-start")?.textContent).toContain("retained-request.txt")
  harness.setFeatures(["note"])
})

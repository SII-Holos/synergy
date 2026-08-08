import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

// The fixture compiles a real Solid bundle through Vite before exercising the
// lifecycle, matching the message-part-error-boundary DOM harness. Keep this
// hook well above the default test timeout so cold caches do not fail it.
const TRANSITION_MS = 160
const TRANSITION_SETTLE_MS = TRANSITION_MS + 80

interface ActivityDomHarness {
  resetCount: (identity: string, value: number) => void
  setCountValue: (value: number) => void
  setSummaryCompleted: (completed: boolean) => void
}

let fixtureDirectory: string
let dom: JSDOM
let harness: ActivityDomHarness

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const reducedMotion = { current: false }

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
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".activity-trace-dom-fixture-"))
  const componentPath = path.resolve(import.meta.dir, "../../src/components/activity-trace.tsx")
  const i18nPath = path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")
  const entry = path.join(fixtureDirectory, "main.tsx")

  await Bun.write(
    entry,
    `
      import { batch, createSignal } from "solid-js"
      import { render } from "solid-js/web"
      import { I18nProvider } from "@lingui/solid"
      import { setupI18n } from ${JSON.stringify(i18nPath)}
      import { ActivityTrace, AnimatedActivityCount, MinimalActivitySummary } from ${JSON.stringify(componentPath)}

      const [countValue, setCountValue] = createSignal(9)
      const [countIdentity, setCountIdentity] = createSignal("turn-a")
      const [summaryCompleted, setSummaryCompleted] = createSignal(false)

      const resetCount = (identity: string, value: number) => {
        batch(() => {
          setCountIdentity(identity)
          setCountValue(value)
        })
      }

      const group = {
        kind: "activity-group",
        key: "group-a",
        message: { id: "m1", sessionID: "s", role: "assistant", time: { created: 1 } },
        family: "modify-files",
        scopeKey: "scope-a",
        scopeLabel: "src/components",
        state: "waiting-approval",
        steps: [
          { part: { id: "p1" }, family: "modify-files", scopeKey: "scope-a", icon: "file-pen", title: "Edit activity-trace", state: "waiting-approval" },
          { part: { id: "p2" }, family: "modify-files", scopeKey: "scope-a", icon: "file-pen", title: "Add tests", state: "done" },
        ],
        receipt: false,
      }

      const i18n = setupI18n()
      const root = document.querySelector("#root")!
      render(
        () => (
          <I18nProvider i18n={i18n}>
            <div id="count-host">
              <AnimatedActivityCount value={countValue()} identity={countIdentity()} />
            </div>
            <MinimalActivitySummary
              item={{
                kind: "activity-summary",
                key: "summary-a",
                message: { id: "m1", sessionID: "s", role: "assistant", time: { created: 1 } },
                total: 9,
                facts: [{ family: "modify-files", count: 3 }],
                completed: summaryCompleted(),
              }}
            />
            <ActivityTrace group={group} serverUrl="http://localhost" />
          </I18nProvider>
        ),
        root,
      )

      ;(globalThis as unknown as { __activityDomHarness: unknown }).__activityDomHarness = {
        resetCount: (identity: string, value: number) => resetCount(identity, value),
        setCountValue: (value: number) => setCountValue(value),
        setSummaryCompleted: (completed: boolean) => setSummaryCompleted(completed),
      }
    `,
  )

  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [solidPlugin()],
    build: {
      outDir: path.join(fixtureDirectory, "dist"),
      emptyOutDir: true,
      minify: false,
      lib: {
        entry,
        formats: ["es"],
        fileName: "fixture",
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  })

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

  await import(`${pathToFileURL(path.join(fixtureDirectory, "dist", "fixture.js")).href}?test=${Date.now()}`)
  harness = (globalThis as unknown as { __activityDomHarness: ActivityDomHarness }).__activityDomHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("AnimatedActivityCount DOM behavior", () => {
  test("first mount snaps to the initial value without a transition", () => {
    expect(countSlot("activity-count-new")?.textContent).toBe("9")
    expect(countSlot("activity-count-old")).toBeNull()
    expect(countRoot().hasAttribute("data-animating")).toBe(false)
    expect(countRoot().getAttribute("aria-label")).toBe("9")
  })

  test.each([
    [9, 10],
    [20, 21],
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

describe("ActivityTrace DOM behavior", () => {
  function trigger(): HTMLButtonElement {
    return document.querySelector('[data-slot="activity-trace-trigger"]') as HTMLButtonElement
  }

  test("trigger is a keyboard-accessible button that toggles the step list", async () => {
    expect(trigger().tagName).toBe("BUTTON")
    expect(trigger().getAttribute("type")).toBe("button")
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('[data-slot="activity-step-list"]')).toBeNull()
    expect(document.querySelector('[data-slot="activity-trace-title"]')?.textContent).toBe("Changed")

    trigger().click()
    await wait(0)
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    const list = document.querySelector('[data-slot="activity-step-list"]')
    expect(list).not.toBeNull()
    expect(list?.querySelectorAll('[data-slot="activity-step"]')).toHaveLength(2)

    trigger().click()
    await wait(0)
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector('[data-slot="activity-step-list"]')).toBeNull()
  })

  test("renders the waiting approval state once within its step", async () => {
    trigger().click()
    await wait(0)

    const waitingStep = document.querySelector('[data-slot="activity-step"][data-state="waiting-approval"]')
    expect(waitingStep?.querySelectorAll('[data-slot="activity-state"]')).toHaveLength(1)
    expect(waitingStep?.textContent?.match(/Waiting for approval/g)).toHaveLength(1)

    trigger().click()
    await wait(0)
  })
})

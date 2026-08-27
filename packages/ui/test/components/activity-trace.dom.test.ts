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
  setRailState: (state: "running" | "done") => void
  refreshActivityGroup: () => void
  getNavigateCalls: () => string[]
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
  const toolRendersPath = path.resolve(import.meta.dir, "../../src/components/tool-renders.tsx")
  const codeContextPath = path.resolve(import.meta.dir, "../../src/context/code.tsx")
  const dataContextPath = path.resolve(import.meta.dir, "../../src/context/data.tsx")
  const pluginThemePath = path.resolve(import.meta.dir, "../../../plugin/src/theme/index.ts")
  const entry = path.join(fixtureDirectory, "main.tsx")

  await Bun.write(
    entry,
    `
      import { batch, createSignal } from "solid-js"
      import { render } from "solid-js/web"
      import { I18nProvider } from "@lingui/solid"
      import { setupI18n } from ${JSON.stringify(i18nPath)}
      import { CodeComponentProvider } from ${JSON.stringify(codeContextPath)}
      import { DataProvider } from ${JSON.stringify(dataContextPath)}
      import ${JSON.stringify(toolRendersPath)}
      import { ActivityReasoningSummary, ActivityReceipt, ActivityTrace, AnimatedActivityCount, MinimalActivitySummary } from ${JSON.stringify(componentPath)}

      const [countValue, setCountValue] = createSignal(9)
      const [countIdentity, setCountIdentity] = createSignal("turn-a")
      const [summaryCompleted, setSummaryCompleted] = createSignal(false)
      const [railState, setRailState] = createSignal<"running" | "done">("running")

      const resetCount = (identity: string, value: number) => {
        batch(() => {
          setCountIdentity(identity)
          setCountValue(value)
        })
      }

      const message = { id: "m1", sessionID: "s", role: "assistant", time: { created: 1 } }
      const group = {
        kind: "activity-group",
        key: "group-a",
        message,
        family: "modify-files",
        scopeKey: "scope-a",
        state: "waiting-approval",
        steps: [
          {
            part: {
              id: "p1",
              tool: "save_file",
              state: {
                status: "completed",
                input: { filePath: "/workspace/packages/ui/src/components/activity-trace.tsx" },
                output: "saved",
                metadata: {
                  filediff: {
                    file: "packages/ui/src/components/activity-trace.tsx",
                    additions: 2,
                    deletions: 1,
                    preview: "old activity trace\\nnew activity trace",
                  },
                },
              },
            },
            family: "modify-files",
            scopeKey: "scope-a",
            icon: "file-pen",
            title: "Edit activity-trace",
            state: "waiting-approval",
          },
          {
            part: {
              id: "p2",
              tool: "websearch",
              state: { status: "completed", input: { query: "activity topic grouping" }, output: "found", metadata: {} },
            },
            family: "research-web",
            scopeKey: "activity-topic",
            icon: "globe",
            title: "Search activity topic grouping",
            state: "done",
          },
        ],
        receipt: false,
        topic: { state: "stable", text: "Updated the activity presentation" },
      }
      const [activityGroup, setActivityGroup] = createSignal(group)
      const railGroup = (state: "running" | "done", key: string) => ({
        ...group,
        key,
        state,
        scopeKey: key,
        steps: [{ ...group.steps[1], part: { ...group.steps[1].part, id: key }, scopeKey: key, state }],
        topic: { state: state === "done" ? "stable" : "live", text: state === "done" ? "Finished rail work" : "Working through rail steps" },
      })
      const viewFileGroup = {
        ...group,
        key: "group-view-file",
        family: "inspect-local",
        scopeKey: "activity-trace.tsx",
        state: "done",
        steps: [
          {
            part: {
              id: "view-file",
              tool: "view_file",
              state: {
                status: "completed",
                input: { filePath: "/workspace/packages/ui/src/components/activity-trace.tsx" },
                output: "[activity-trace.tsx#TEST]\\n1:const parity = true",
                metadata: {
                  filepath: "/workspace/packages/ui/src/components/activity-trace.tsx",
                  content: "const parity = true",
                  tag: "TEST",
                  totalLines: 1,
                  offset: 0,
                  limit: 1,
                  ranges: [],
                },
              },
            },
            family: "inspect-local",
            scopeKey: "activity-trace.tsx",
            icon: "glasses",
            title: "View activity-trace.tsx",
            state: "done",
          },
        ],
        topic: { state: "stable", text: "Read the Activity Trace source" },
      }
      const errorGroup = {
        kind: "activity-group",
        key: "group-error",
        message,
        family: "execute",
        scopeKey: "build.sh",
        state: "error",
        steps: [
          {
            part: {
              id: "p-error",
              tool: "bash",
              state: {
                status: "error",
                input: { command: "bash build.sh" },
                error: "bash: build.sh: command not found\\nexit code 127",
                metadata: {
                  approval: {
                    status: "auto_allowed",
                    mode: "autonomous",
                    risk: "medium",
                    audit: { visible: true },
                  },
                },
                time: { start: 1, end: 2 },
              },
            },
            family: "execute",
            scopeKey: "build.sh",
            icon: "terminal",
            title: "Run build.sh",
            subtitle: "build.sh",
            state: "error",
          },
        ],
        receipt: false,
      }
      const delegateGroup = {
        kind: "activity-group",
        key: "group-delegate",
        message,
        family: "delegate",
        scopeKey: "task:child-1",
        state: "done",
        steps: [
          {
            part: {
              id: "p-task",
              tool: "task",
              state: {
                status: "completed",
                input: { subagent_type: "explore", description: "Inspect the registry" },
                output: "done",
                metadata: {
                  sessionId: "child-1",
                  background: false,
                  summary: [
                    { id: "c1", tool: "bash", state: { status: "completed", title: "Ran tests" } },
                    { id: "c2", tool: "read", state: { status: "running" } },
                    { id: "c3", tool: "grep", state: { status: "generating" } },
                  ],
                },
              },
            },
            family: "delegate",
            scopeKey: "task:child-1",
            icon: "list-todo",
            title: "Call subagent",
            subtitle: "Inspect the registry",
            state: "done",
          },
        ],
        receipt: false,
      }
      const delegateBackgroundGroup = {
        ...delegateGroup,
        key: "group-delegate-bg",
        scopeKey: "task:child-2",
        steps: [
          {
            ...delegateGroup.steps[0],
            part: {
              ...delegateGroup.steps[0].part,
              id: "p-task-bg",
              state: {
                ...delegateGroup.steps[0].part.state,
                status: "completed",
                metadata: { sessionId: "child-2", background: true, summary: [] },
              },
            },
            scopeKey: "task:child-2",
            state: "done",
          },
        ],
      }
      const taskReceipt = {
        kind: "activity-receipt",
        key: "receipt-task",
        message,
        group: {
          ...delegateGroup,
          key: "group-delegate-receipt",
          state: "error",
          receipt: true,
          steps: [
            {
              ...delegateGroup.steps[0],
              part: {
                ...delegateGroup.steps[0].part,
                id: "p-task-err",
                state: {
                  status: "error",
                  input: { subagent_type: "explore", description: "Inspect the registry" },
                  error: "Agent type scout is not visible to synergy",
                  metadata: { sessionId: "child-3", background: false, summary: [] },
                },
              },
              state: "error",
            },
          ],
        },
      }
      function CodeFixture(props: { file: { contents: string } }) {
        return <pre data-component="code-fixture">{props.file.contents}</pre>
      }
      const dagReceipt = {
        kind: "activity-receipt",
        key: "receipt-dag",
        message,
        group: {
          kind: "activity-group",
          key: "group-dag",
          message,
          family: "coordination",
          scopeKey: "",
          state: "done",
          steps: [
            {
              part: {
                id: "dag-read",
                tool: "dagread",
                state: {
                  status: "completed",
                  input: {},
                  output: "",
                  metadata: {
                    nodes: [{ id: "inspect", content: "Inspect activity projection", status: "completed", deps: [] }],
                    ready: [],
                  },
                },
              },
              family: "coordination",
              scopeKey: "",
              icon: "list-checks",
              title: "Read DAG",
              subtitle: "DAG snapshot",
              state: "done",
            },
          ],
          receipt: true,
        },
      }

      const i18n = setupI18n()
      const navigateCalls: string[] = []
      const data = {
        session: [],
        session_status: {},
        session_diff: {},
        permission: {},
        message: {},
        part: {},
      }
      const root = document.querySelector("#root")!
      render(
        () => (
          <I18nProvider i18n={i18n}>
            <DataProvider data={data} directory="/workspace" serverUrl="http://localhost" onNavigateToSession={(id) => navigateCalls.push(id)}>

            <CodeComponentProvider component={CodeFixture}>
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
                  now: { text: "Verifying compressed activity", source: "reasoning", updatedAt: 10 },
                }}
              />
              <div id="activity-main-host">
                <ActivityTrace group={activityGroup()} serverUrl="http://localhost" />
              </div>
              <div id="activity-rail-host">
                <div data-slot="session-turn-timeline-item" data-kind="activity-group" data-activity-continues="">
                  <ActivityTrace group={railGroup(railState(), "rail-running")} serverUrl="http://localhost" />
                </div>
                <div data-slot="session-turn-timeline-item" data-kind="activity-group">
                  <ActivityTrace group={railGroup("done", "rail-done")} serverUrl="http://localhost" />
                </div>
              </div>
              <div id="view-file-host">
                <ActivityTrace group={viewFileGroup} serverUrl="http://localhost" />
              </div>
              <div id="error-host">
                <ActivityTrace group={errorGroup} serverUrl="http://localhost" />
              </div>
              <div id="delegate-host">
                <ActivityTrace group={delegateGroup} serverUrl="http://localhost" />
              </div>
              <div id="delegate-bg-host">
                <ActivityTrace group={delegateBackgroundGroup} serverUrl="http://localhost" />
              </div>
              <div id="task-receipt-host">
                <ActivityReceipt item={taskReceipt} serverUrl="http://localhost" />
              </div>
              <div id="dag-receipt-host">
                <ActivityReceipt item={dagReceipt} serverUrl="http://localhost" />
              </div>
              <div id="reasoning-summary-host">
                <ActivityReasoningSummary
                  item={{ kind: "activity-reasoning-summary", key: "reasoning-pending", message: group.message, partID: "rp", state: "pending" }}
                />
                <ActivityReasoningSummary
                  item={{ kind: "activity-reasoning-summary", key: "reasoning-live", message: group.message, partID: "rl", state: "live", text: "Tracing the message flow", source: "nano" }}
                />
                <ActivityReasoningSummary
                  item={{ kind: "activity-reasoning-summary", key: "reasoning-stable", message: group.message, partID: "rs", state: "stable", text: "Mapped the message flow", source: "nano" }}
                />
                <ActivityReasoningSummary
                  item={{ kind: "activity-reasoning-summary", key: "reasoning-fallback", message: group.message, partID: "rf", state: "fallback" }}
                />
              </div>
            </CodeComponentProvider>
            </DataProvider>
          </I18nProvider>
        ),
        root,
      )

      ;(globalThis as unknown as { __activityDomHarness: unknown }).__activityDomHarness = {
        resetCount: (identity: string, value: number) => resetCount(identity, value),
        setCountValue: (value: number) => setCountValue(value),
        setSummaryCompleted: (completed: boolean) => setSummaryCompleted(completed),
        setRailState: (state: "running" | "done") => setRailState(state),
        getNavigateCalls: () => navigateCalls.slice(),

        refreshActivityGroup: () =>
          setActivityGroup((current) => ({
            ...current,
            steps: current.steps.map((step) => ({
              ...step,
              part: { ...step.part, state: { ...step.part.state } },
            })),
          })),
      }
    `,
  )

  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [solidPlugin()],
    resolve: {
      // Vite resolves @ericsanchezok/synergy-plugin/* through the exports map's
      // "import" condition, which points at dist/ artifacts that only exist
      // after the plugin package is built. CI checks out a clean tree, so
      // point the theme subpath at the plugin sources like the other fixture
      // tests do.
      alias: { "@ericsanchezok/synergy-plugin/theme": pluginThemePath },
    },
    worker: { format: "es" },
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
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLHeadElement: window.HTMLHeadElement,
    SVGElement: window.SVGElement,
    customElements: window.customElements,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
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
    expect(now?.textContent).toBe("Verifying compressed activity")
    expect(now?.getAttribute("aria-hidden")).toBe("true")
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
    ).toEqual(["Changed", "Researched"])
    expect(list?.querySelector('[data-slot="activity-step-branch"]')).toBeNull()
  })

  test("exposes the full step title to hover when narrow layouts truncate it", () => {
    const title = document.querySelector('#activity-main-host [data-slot="activity-step-title"]')
    expect(title?.textContent).toBe("Edit activity-trace")
    expect(title?.getAttribute("title")).toBe("Edit activity-trace")
  })

  test("exposes the full step subtitle to hover when narrow layouts truncate it", () => {
    const subtitle = document.querySelector('#error-host [data-slot="activity-step-subtitle"]')
    expect(subtitle?.textContent).toBe("build.sh")
    expect(subtitle?.getAttribute("title")).toBe("build.sh")
  })

  test("each child activity is a keyboard-accessible result toggle", async () => {
    const triggers = stepTriggers()
    expect(triggers).toHaveLength(8)
    expect(triggers[0]?.tagName).toBe("BUTTON")
    expect(triggers[0]?.getAttribute("type")).toBe("button")
    expect(triggers[0]?.getAttribute("aria-expanded")).toBe("false")

    triggers[0]?.click()
    await wait(0)
    expect(triggers[0]?.getAttribute("aria-expanded")).toBe("true")

    triggers[0]?.click()
    await wait(0)
    expect(triggers[0]?.getAttribute("aria-expanded")).toBe("false")
  })

  test("preserves an expanded child when streaming replaces activity projections", async () => {
    const host = document.querySelector("#activity-main-host") as HTMLElement
    let trigger = host.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement

    trigger.click()
    await wait(0)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")

    harness.refreshActivityGroup()
    await wait(0)

    trigger = host.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement
    expect(trigger.getAttribute("aria-expanded")).toBe("true")

    trigger.click()
    await wait(0)
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

    const fileStep = document.querySelector('#activity-main-host [data-slot="activity-step"]')
    expect(fileStep?.querySelector('[data-component="diff-preview"], [data-component="diff-patch"]')).not.toBeNull()

    firstTrigger.click()
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
    expect(updatedStep.textContent).toContain("Done")
  })

  test("renders view_file through the Full-mode renderer body without a nested tool card", async () => {
    const viewHost = document.querySelector("#view-file-host") as HTMLElement
    const viewTrigger = viewHost.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement
    viewTrigger.click()
    await wait(0)

    expect(viewHost.querySelector('[data-component="tool-result-body"]')).not.toBeNull()
    expect(viewHost.querySelector('[data-component="anchored-summary"]')).not.toBeNull()
    expect(viewHost.querySelector('[data-component="view-content"]')).not.toBeNull()
    expect(viewHost.querySelector('[data-component="code-fixture"]')?.textContent).toBe("const parity = true")
    expect(viewHost.querySelector('[data-component="tool-output-text"]')).toBeNull()
    expect(viewHost.querySelector('[data-component="collapsible"][data-variant="tool"]')).toBeNull()
  })

  test("keeps a failed step collapsed by default and reveals the full error inline after one click", async () => {
    const host = document.querySelector("#error-host") as HTMLElement
    const trigger = host.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector('[data-component="error-card"]')).toBeNull()

    trigger.click()
    await wait(0)

    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector('[data-component="error-card"]')).not.toBeNull()
    expect(host.textContent).toContain("command not found")
    expect(host.textContent).toContain("exit code 127")
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

    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(
      host.querySelector('[data-component="tool-output"] > [data-component="task-subagent-detail"]'),
    ).not.toBeNull()
    expect(host.querySelector('[data-slot="task-subagent-agent"]')?.textContent).toBe("explore")
    expect(host.querySelector('[data-slot="task-subagent-description"]')?.textContent).toBe("Inspect the registry")
    expect(host.querySelectorAll('[data-slot="task-tool-item"]')).toHaveLength(3)
    expect(
      host.querySelector('[data-slot="task-tool-item"][data-state="running"] [data-slot="task-tool-status"]'),
    ).not.toBeNull()

    const open = host.querySelector('[data-slot="task-subagent-open"]') as HTMLButtonElement
    expect(open?.tagName).toBe("BUTTON")
    open?.click()
    await wait(0)
    expect(harness.getNavigateCalls()).toEqual(["child-1"])

    trigger.click()
    await wait(0)
  })

  test("shows an honest background empty state instead of a blank expansion", async () => {
    const host = document.querySelector("#delegate-bg-host") as HTMLElement
    const trigger = host.querySelector('[data-slot="activity-step-trigger"]') as HTMLButtonElement
    trigger.click()
    await wait(0)

    expect(host.querySelector('[data-component="task-subagent-detail"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="task-subagent-background"]')?.textContent).toBe("background")
    const empty = host.querySelector('[data-slot="task-subagent-empty"]') as HTMLElement
    expect(empty?.textContent).toContain("Running in background")
    expect(empty?.querySelector('[data-component="spinner"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="task-subagent-open"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-slot="task-tool-item"]')).toHaveLength(0)
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
    await wait(0)

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
    await wait(0)

    expect(receiptTrigger.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector('[data-component="task-subagent-detail"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="task-subagent-error"]')?.textContent).toBe(
      "Agent type scout is not visible to synergy",
    )
    expect(host.querySelector('[data-slot="task-subagent-empty"]')).toBeNull()
    expect(host.querySelectorAll('[data-slot="task-tool-item"]')).toHaveLength(0)
  })
})

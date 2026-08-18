import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

interface TimelineBoundaryHarness {
  setStableTick: (value: number) => void
  setExplodingTick: (value: number) => void
  setStale: (value: boolean) => void
  getProxyReads: () => number
  getThrows: () => number
}

let fixtureDirectory: string
let harness: TimelineBoundaryHarness
let dom: JSDOM

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 20))

const stableReasoningNode = () => document.querySelector('#root-stable [data-component="compact-reasoning"]')
const explodingReasoningNode = () => document.querySelector('#root-exploding [data-component="compact-reasoning"]')
const stableErrorCard = () => document.querySelector('#root-stable [data-slot="session-turn-timeline-item-error"]')
const explodingErrorCard = () =>
  document.querySelector('#root-exploding [data-slot="session-turn-timeline-item-error"]')

beforeAll(async () => {
  // The fixture compiles a real Solid bundle through Vite before exercising
  // the lifecycle; keep this hook well above the default 5s test timeout so
  // direct `bun test` invocations do not fail on cold caches or slow disks.
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".session-turn-timeline-boundary-fixture-"))
  const sessionTurnPath = path.resolve(import.meta.dir, "../../src/components/session-turn.tsx")
  const i18nPath = path.resolve(import.meta.dir, "../../src/testing/i18n.tsx")
  const pluginThemePath = path.resolve(import.meta.dir, "../../../plugin/src/theme/index.ts")
  const entry = path.join(fixtureDirectory, "main.tsx")

  await Bun.write(
    entry,
    `
      import { I18nProvider } from "@lingui/solid"
      import { createSignal } from "solid-js"
      import { render } from "solid-js/web"
      import { TimelineDisplay } from ${JSON.stringify(sessionTurnPath)}
      import { setupI18n } from ${JSON.stringify(i18nPath)}

      const i18n = setupI18n()
      const sessionID = "boundary-session"
      const message = {
        id: "assistant-boundary",
        sessionID,
        role: "assistant",
        parentID: "user-boundary",
        rootID: "user-boundary",
        mode: "test",
        agent: "synergy",
        path: { cwd: "/workspace", root: "/workspace" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "model",
        providerID: "provider",
        time: { created: 1, completed: 2 },
        finish: "stop",
      }
      const stableBasePart = {
        id: "reasoning-stable",
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: "seed",
      }
      const rawExplodingPart = {
        id: "reasoning-exploding",
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: "unused",
      }
      // A part object whose accessors throw once its owning reactive boundary
      // is stale, mirroring the disposed Switch guard reads from the
      // session-switch crash.
      let stale = false
      let proxyReads = 0
      let throws = 0
      const explodingPart = new Proxy(rawExplodingPart, {
        get(target, property, receiver) {
          if (property === "text") {
            proxyReads++
            if (stale) {
              throws++
              throw new Error("Stale read from <Switch>.")
            }
          }
          return Reflect.get(target, property, receiver)
        },
      })

      let setStableTick: (value: number) => void
      let setExplodingTick: (value: number) => void

      function StableTimeline() {
        const [tick, setTick] = createSignal(0)
        setStableTick = setTick
        // The app replaces streaming part objects on every reconcile tick, so
        // the display item is a fresh reference on every read.
        const item = () => ({
          kind: "passthrough",
          item: { kind: "reasoning", message, part: { ...stableBasePart, text: "Stable line " + tick() } },
          message,
        })
        return (
          <I18nProvider i18n={i18n}>
            <TimelineDisplay item={item()} serverUrl="http://localhost" working={false} compactReasoning />
          </I18nProvider>
        )
      }

      function ExplodingTimeline() {
        const [tick, setTick] = createSignal(0)
        setExplodingTick = setTick
        // Reading tick() keeps the item reactive: every tick replaces the
        // display item reference, mirroring reconcile of a streaming part.
        const item = () => ({
          kind: "passthrough",
          item: { kind: "reasoning", message, part: explodingPart, tick: tick() },
          message,
        })
        return (
          <I18nProvider i18n={i18n}>
            <TimelineDisplay item={item()} serverUrl="http://localhost" working={false} compactReasoning />
          </I18nProvider>
        )
      }

      render(() => <StableTimeline />, document.querySelector("#root-stable"))
      render(() => <ExplodingTimeline />, document.querySelector("#root-exploding"))

      globalThis.__timelineBoundaryHarness = {
        setStableTick: (value: number) => setStableTick(value),
        setExplodingTick: (value: number) => setExplodingTick(value),
        setStale: (value: boolean) => {
          stale = value
        },
        getProxyReads: () => proxyReads,
        getThrows: () => throws,
      }
    `,
  )

  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [solidPlugin()],
    resolve: {
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

  await import(`${pathToFileURL(path.join(fixtureDirectory, "dist", "fixture.js")).href}?test=${Date.now()}`)
  harness = (globalThis as typeof globalThis & { __timelineBoundaryHarness: TimelineBoundaryHarness })
    .__timelineBoundaryHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
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

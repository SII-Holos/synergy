import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

interface DisposeGuardHarness {
  setLiveTick: (value: number) => void
  setSwitchTick: (value: number) => void
  setDisposedTick: (value: number) => void
  disposeDisposed: () => void
  getErrors: () => unknown[]
  getLiveNode: () => Element | null
  getSwitchNode: () => Element | null
  getDisposedChildren: () => number
}

let fixtureDirectory: string
let harness: DisposeGuardHarness
let dom: JSDOM

const waitForUpdate = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeAll(async () => {
  // The fixture compiles a real Solid bundle through Vite before exercising
  // the lifecycle; keep this hook well above the default 5s test timeout so
  // direct `bun test` invocations do not fail on cold caches or slow disks.
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".session-turn-dispose-guard-fixture-"))
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
      const sessionID = "dispose-guard-session"
      const message = {
        id: "assistant-dispose-guard",
        sessionID,
        role: "assistant",
        parentID: "user-dispose-guard",
        rootID: "user-dispose-guard",
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
      const capturedErrors: unknown[] = []
      window.addEventListener("error", (event) => {
        capturedErrors.push(event.error ?? event.message)
      })


      function LiveTimeline() {
        const [tick, setTick] = createSignal(0)
        globalThis.__setLiveTick = setTick
        const item = () => ({
          kind: "passthrough",
          item: { kind: "reasoning", message, part: { id: "part-live", sessionID, messageID: message.id, type: "reasoning", text: "Live line " + tick() } },
          message,
        })
        return (
          <I18nProvider i18n={i18n}>
            <TimelineDisplay item={item()} serverUrl="http://localhost" working={false} compactReasoning />
          </I18nProvider>
        )
      }

      function SwitchingTimeline() {
        const [tick, setTick] = createSignal(0)
        globalThis.__setSwitchTick = setTick
        const item = () =>
          tick() % 2 === 0
            ? {
                kind: "passthrough",
                item: { kind: "reasoning", message, part: { id: "part-switch", sessionID, messageID: message.id, type: "reasoning", text: "Reasoning " + tick() } },
                message,
              }
            : {
                kind: "activity-reasoning-summary",
                key: "reasoning-summary-switch",
                message,
                partID: "part-switch",
                state: "stable",
                text: "Summary " + tick(),
              }
        return (
          <I18nProvider i18n={i18n}>
            <TimelineDisplay item={item()} serverUrl="http://localhost" working={false} compactReasoning />
          </I18nProvider>
        )
      }

      function DisposedTimeline() {
        const [tick, setTick] = createSignal(0)
        globalThis.__setDisposedTick = setTick
        const item = () => ({
          kind: "passthrough",
          item: { kind: "reasoning", message, part: { id: "part-disposed", sessionID, messageID: message.id, type: "reasoning", text: "Disposed line " + tick() } },
          message,
        })
        return (
          <I18nProvider i18n={i18n}>
            <TimelineDisplay item={item()} serverUrl="http://localhost" working={false} compactReasoning />
          </I18nProvider>
        )
      }

      render(() => <LiveTimeline />, document.querySelector("#root-live"))
      render(() => <SwitchingTimeline />, document.querySelector("#root-switching"))
      globalThis.__disposeDisposed = render(() => <DisposedTimeline />, document.querySelector("#root-disposed"))

      globalThis.__disposeGuardHarness = {
        setLiveTick: (value: number) => globalThis.__setLiveTick(value),
        setSwitchTick: (value: number) => globalThis.__setSwitchTick(value),
        setDisposedTick: (value: number) => globalThis.__setDisposedTick(value),
        disposeDisposed: () => globalThis.__disposeDisposed(),
        getErrors: () => capturedErrors,
        getLiveNode: () => document.querySelector('#root-live [data-component="compact-reasoning"]'),
        getSwitchNode: () => document.querySelector('#root-switching [data-component="compact-reasoning"]'),
        getDisposedChildren: () => document.querySelector("#root-disposed")?.childNodes.length ?? 0,
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
    '<!doctype html><html><body><div id="root-live"></div><div id="root-switching"></div><div id="root-disposed"></div></body></html>',
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
    cancelAnimationFrame: (id: number) => setTimeout(() => clearTimeout(id), 0),
  })

  await import(`${pathToFileURL(path.join(fixtureDirectory, "dist", "fixture.js")).href}?test=${Date.now()}`)
  harness = (globalThis as typeof globalThis & { __disposeGuardHarness: DisposeGuardHarness }).__disposeGuardHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("session turn timeline dispose guard", () => {
  test("renders a healthy timeline item and streams into the mounted node", async () => {
    expect(harness.getLiveNode()?.textContent).toContain("Live line 0")
    const before = harness.getLiveNode()
    harness.setLiveTick(1)
    await waitForUpdate()
    const after = harness.getLiveNode()
    expect(after).toBe(before)
    expect(after?.textContent).toContain("Live line 1")
    expect(harness.getErrors()).toEqual([])
  })

  test("switches branch kind between ticks without remounting into the wrong branch", async () => {
    expect(harness.getSwitchNode()?.textContent).toContain("Reasoning 0")
    harness.setSwitchTick(1)
    await waitForUpdate()
    // Kind flips to activity-reasoning-summary: the reasoning row unmounts
    // and the summary renders; no uncaught error may escape the kind-keyed
    // guard while the branch switches.
    expect(harness.getSwitchNode()).toBeNull()
    expect(document.querySelector('#root-switching [data-component="reasoning-summary"]')).not.toBeNull()
    harness.setSwitchTick(2)
    await waitForUpdate()
    expect(harness.getSwitchNode()?.textContent).toContain("Reasoning 2")
    expect(harness.getErrors()).toEqual([])
  })

  test("disposing the owner and ticking does not surface uncaught errors", async () => {
    harness.disposeDisposed()
    expect(harness.getDisposedChildren()).toBe(0)
    harness.setDisposedTick(1)
    await waitForUpdate()
    expect(harness.getDisposedChildren()).toBe(0)
    expect(harness.getErrors()).toEqual([])
  })
})

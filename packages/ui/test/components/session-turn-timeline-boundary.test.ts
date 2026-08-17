import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build } from "vite"
import solidPlugin from "vite-plugin-solid"

interface TimelineBoundaryResult {
  stableText: string | null
  hasErrorCard: boolean
  explodingText: string | null
}

let fixtureDirectory: string
let result: TimelineBoundaryResult
let dom: JSDOM

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
      import { render } from "solid-js/web"
      import { TimelineDisplay } from ${JSON.stringify(sessionTurnPath)}
      import { setupI18n } from ${JSON.stringify(i18nPath)}

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
      const stablePart = {
        id: "reasoning-stable",
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: "Stable summary line\\nmore detail",
      }
      const rawExplodingPart = {
        id: "reasoning-exploding",
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: "unused",
      }
      // A reactive accessor that throws once its owning boundary is stale,
      // mirroring the disposed Switch guard reads from the session-switch crash.
      const explodingPart = new Proxy(rawExplodingPart, {
        get(target, property, receiver) {
          if (property === "text") throw new Error("Stale read from <Switch>.")
          return Reflect.get(target, property, receiver)
        },
      })
      const stableItem = {
        kind: "passthrough",
        item: { kind: "reasoning", message, part: stablePart },
        message,
      }
      const explodingItem = {
        kind: "passthrough",
        item: { kind: "reasoning", message, part: explodingPart },
        message,
      }

      render(
        () => (
          <I18nProvider i18n={setupI18n()}>
            <TimelineDisplay item={stableItem} serverUrl="http://localhost" working={false} compactReasoning />
          </I18nProvider>
        ),
        document.querySelector("#root-stable"),
      )
      render(
        () => (
          <I18nProvider i18n={setupI18n()}>
            <TimelineDisplay item={explodingItem} serverUrl="http://localhost" working={false} compactReasoning />
          </I18nProvider>
        ),
        document.querySelector("#root-exploding"),
      )

      globalThis.__timelineBoundaryResult = {
        stableText: document.querySelector("#root-stable")?.textContent ?? null,
        hasErrorCard: !!document.querySelector("#root-exploding [data-component='error-card']"),
        explodingText: document.querySelector("#root-exploding")?.textContent ?? null,
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
  result = (globalThis as typeof globalThis & { __timelineBoundaryResult: TimelineBoundaryResult })
    .__timelineBoundaryResult
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("session turn timeline item renderer boundary", () => {
  test("keeps a failing timeline item local and renders stable reasoning rows", () => {
    expect(result.stableText).toContain("Stable summary line")
    expect(result.hasErrorCard).toBe(true)
    // The failing item must not take down the surrounding surface; its error
    // surfaces inside the local error card instead.
    expect(result.explodingText).toContain("Stale read from <Switch>.")
  })
})

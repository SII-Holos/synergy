import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build, type Plugin } from "vite"
import solidPlugin from "vite-plugin-solid"

// The fixture compiles the real Solid DiffPatch component through Vite before
// exercising lifecycle behavior, matching the activity-trace DOM harness.
// @pierre/diffs, the worker pool, the theme loader, and the pierre wrapper are
// replaced with deterministic fake modules (enforce:"pre" resolveId) so the
// bundle is offline-safe and the render/parse counts are observable.
// Keep this hook well above the default test timeout so cold caches pass.
const PATCH = [
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1",
  "+const b = 2",
  " const c = 3",
].join("\n")

const OTHER_PATCH = ["--- a/src/bar.ts", "+++ b/src/bar.ts", "@@ -1,2 +1,2 @@", "-old", "+new"].join("\n")

interface DiffHarness {
  reset: () => void
  resolveTheme: () => void
  setGatePatch: (patch: string) => void
  churnSame: () => void
  churnChange: () => void
  counts: () => { parse: number; render: number }
}

let fixtureDirectory: string
let dom: JSDOM
let harness: DiffHarness

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function directFallback(): Element | null {
  return document.querySelector('#direct-host [data-component="diff-patch-fallback"]')
}
function richRender(host: string): Element | null {
  return document.querySelector(`${host} [data-component="fake-pierre-render"]`)
}
function gateFallback(): Element | null {
  return document.querySelector('#gate-host [data-component="gate-fallback"]')
}
function churnFallback(): Element | null {
  return document.querySelector('#churn-host [data-component="diff-patch-fallback"]')
}

const FAKE_PIERRE = `
type FixtureState = { parseCalls: number; renderCalls: number }
const state = ((globalThis as any).__diffFixtureState ??= { parseCalls: 0, renderCalls: 0 }) as FixtureState

export function parsePatchFiles(patch: string): any[] {
  state.parseCalls++
  if (typeof patch === "string" && patch.includes("@@") && !patch.includes("===")) {
    return [{ files: [{ file: "fake", additions: 1, deletions: 1, deletionLines: [], additionLines: [] }] }]
  }
  return []
}

export class FileDiff {
  render(opts: { containerWrapper: HTMLElement }): void {
    state.renderCalls++
    const el = document.createElement("div")
    el.setAttribute("data-component", "fake-pierre-render")
    opts.containerWrapper.replaceChildren(el)
  }
  cleanUp(): void {}
}
`

const FAKE_WORKER = `export function getWorkerPool() { return undefined }`

const FAKE_MARKED = `
type ThemeState = { promise?: Promise<unknown>; resolve?: () => void }
const state = ((globalThis as any).__diffThemeState ??= {}) as ThemeState
export function ensureSynergyHighlightTheme(): Promise<unknown> {
  state.promise ??= new Promise((resolve) => { state.resolve = resolve })
  return state.promise
}
`

const FAKE_PIERRE_WRAPPER = `
export function createDefaultOptions(style: string | undefined) {
  return { theme: "Synergy", themeType: "system", disableLineNumbers: false, diffStyle: style ?? "unified" }
}
export const styleVariables = {}
`

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".diff-patch-dom-fixture-"))
  const uiRoot = path.resolve(import.meta.dir, "../..")
  const diffPatchPath = path.join(uiRoot, "src/components/diff-patch.tsx")
  const i18nPath = path.join(uiRoot, "src/testing/i18n.tsx")

  const fakePierrePath = path.join(fixtureDirectory, "fake-pierre.ts")
  const fakeWorkerPath = path.join(fixtureDirectory, "fake-worker.ts")
  const fakeMarkedPath = path.join(fixtureDirectory, "fake-marked.ts")
  const fakeWrapperPath = path.join(fixtureDirectory, "fake-pierre-wrapper.ts")
  await Bun.write(fakePierrePath, FAKE_PIERRE)
  await Bun.write(fakeWorkerPath, FAKE_WORKER)
  await Bun.write(fakeMarkedPath, FAKE_MARKED)
  await Bun.write(fakeWrapperPath, FAKE_PIERRE_WRAPPER)

  const fixtureMocks: Plugin = {
    name: "fixture-diff-mocks",
    // Runs ahead of vite:resolve so the real @pierre/diffs is never bundled.
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !importer.startsWith(uiRoot)) return null
      if (source === "@pierre/diffs") return fakePierrePath
      if (/^..\/pierre\/worker(\.ts)?$/.test(source)) return fakeWorkerPath
      if (/^..\/context\/marked(\.tsx)?$/.test(source)) return fakeMarkedPath
      if (/^..\/pierre$/.test(source)) return fakeWrapperPath
      return null
    },
  }

  const entry = path.join(fixtureDirectory, "main.tsx")
  await Bun.write(
    entry,
    `
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from ${JSON.stringify(i18nPath)}
import { DiffPatch, DiffPatchGate } from ${JSON.stringify(diffPatchPath)}

const PATCH = ${JSON.stringify(PATCH)}
const OTHER = ${JSON.stringify(OTHER_PATCH)}

const [directPatch] = createSignal(PATCH)
const [gatePatch, setGatePatch] = createSignal("garbage text")
const [wrapper, setWrapper] = createSignal({ patch: PATCH })

const i18n = setupI18n()
const root = document.querySelector("#root")!
render(
  () => (
    <I18nProvider i18n={i18n}>
      <div>
        <div id="direct-host">
          <DiffPatch patch={directPatch()} diffStyle="unified" />
        </div>
        <div id="gate-host">
          <DiffPatchGate
            patch={gatePatch()}
            diffStyle="unified"
            fallback={<div data-component="gate-fallback">fallback body</div>}
          />
        </div>
        <div id="churn-host">
          <DiffPatchGate patch={wrapper().patch} diffStyle="unified" fallback={<div>never</div>} />
        </div>
      </div>
    </I18nProvider>
  ),
  root,
)

;(globalThis as any).__diffHarness = {
  reset: () => {
    const state = (globalThis as any).__diffFixtureState
    state.parseCalls = 0
    state.renderCalls = 0
  },
  resolveTheme: () => (globalThis as any).__diffThemeState?.resolve?.(),
  setGatePatch: (patch: string) => setGatePatch(patch),
  churnSame: () => setWrapper((current) => ({ patch: current.patch })),
  churnChange: () => setWrapper({ patch: OTHER }),
  counts: () => {
    const state = (globalThis as any).__diffFixtureState
    return { parse: state.parseCalls, render: state.renderCalls }
  },
}
`,
  )

  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [solidPlugin(), fixtureMocks],
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
  // solid-presence treats unanimated content as settled.
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
    SVGElement: window.SVGElement,
    customElements: window.customElements,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })

  await import(`${pathToFileURL(path.join(fixtureDirectory, "dist", "fixture.js")).href}?test=${Date.now()}`)
  harness = (globalThis as unknown as { __diffHarness: DiffHarness }).__diffHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("DiffPatch progressive rendering", () => {
  test("paints readable plain text before the highlighter upgrade, never blank", async () => {
    harness.reset()
    // The theme promise is deliberately pending: the first frame must still
    // be readable plain text, and the rich render must not exist yet.
    expect(directFallback()?.textContent).toBe(PATCH)
    expect(richRender("#direct-host")).toBeNull()
    expect(churnFallback()?.textContent).toBe(PATCH)
    expect(gateFallback()).not.toBeNull()
    expect(harness.counts()).toEqual({ parse: 0, render: 0 })

    harness.resolveTheme()
    await wait(0)
    expect(richRender("#direct-host")).not.toBeNull()
    expect(directFallback()).toBeNull()
    expect(richRender("#churn-host")).not.toBeNull()
    // The upgrade reuses the already-parsed metadata — no second parse.
    expect(harness.counts()).toEqual({ parse: 0, render: 2 })
  })
})

describe("DiffPatchGate streaming stability", () => {
  test("wrapper churn around an identical patch string does not re-parse or re-render", async () => {
    harness.reset()
    harness.churnSame()
    await wait(0)
    expect(harness.counts()).toEqual({ parse: 0, render: 0 })

    harness.churnSame()
    await wait(0)
    expect(harness.counts()).toEqual({ parse: 0, render: 0 })

    harness.churnChange()
    await wait(0)
    expect(harness.counts()).toEqual({ parse: 1, render: 1 })
    expect(richRender("#churn-host")).not.toBeNull()
  })

  test("falls back for unrenderable patches and transitions when the patch becomes renderable", async () => {
    harness.reset()
    expect(gateFallback()?.textContent).toBe("fallback body")
    expect(document.querySelector('#gate-host [data-component="diff-patch"]')).toBeNull()

    harness.setGatePatch(PATCH)
    await wait(0)
    expect(gateFallback()).toBeNull()
    expect(richRender("#gate-host")).not.toBeNull()
    expect(harness.counts()).toEqual({ parse: 1, render: 1 })
  })
})

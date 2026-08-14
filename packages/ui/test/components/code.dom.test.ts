import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build, type Plugin } from "vite"
import solidPlugin from "vite-plugin-solid"

// The fixture compiles the real Solid Code component through Vite before
// exercising lifecycle behavior, matching the diff-patch DOM harness.
// @pierre/diffs, the worker pool, and the pierre wrapper are replaced with
// deterministic fake modules (enforce:"pre" resolveId) so the bundle is
// offline-safe and the File construction / render counts are observable.
//
// Regression guard for "view-content keeps re-rendering during streaming":
// streaming projections rebuild wrapper objects (file contents + render
// range) around unchanged values; the Code render effect must not wipe and
// rebuild the pierre view on every projection.

interface CodeHarness {
  reset: () => void
  churnSame: () => void
  churnChange: () => void
  counts: () => { constructed: number; render: number }
}

let fixtureDirectory: string
let dom: JSDOM
let harness: CodeHarness

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function rendered(host: string): Element | null {
  return document.querySelector(`${host} [data-component="fake-pierre-render"]`)
}

const FAKE_PIERRE = `
type FixtureState = { constructed: number; render: number }
const state = ((globalThis as any).__codeFixtureState ??= { constructed: 0, render: 0 }) as FixtureState

export class File {
  constructor() {
    state.constructed++
  }
  render(opts: { containerWrapper: HTMLElement }): void {
    state.render++
    const el = document.createElement("div")
    el.setAttribute("data-component", "fake-pierre-render")
    opts.containerWrapper.replaceChildren(el)
  }
  setSelectedLines(): void {}
  cleanUp(): void {}
}
`

const FAKE_WORKER = `export function getWorkerPool() { return undefined }`

const FAKE_PIERRE_WRAPPER = `
export function createDefaultOptions(style: string | undefined) {
  return { theme: "Synergy", themeType: "system", disableLineNumbers: false, diffStyle: style ?? "unified" }
}
export const styleVariables = {}
`

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".code-dom-fixture-"))
  const uiRoot = path.resolve(import.meta.dir, "../..")
  const codePath = path.join(uiRoot, "src/components/code.tsx")

  const fakePierrePath = path.join(fixtureDirectory, "fake-pierre.ts")
  const fakeWorkerPath = path.join(fixtureDirectory, "fake-worker.ts")
  const fakeWrapperPath = path.join(fixtureDirectory, "fake-pierre-wrapper.ts")
  await Bun.write(fakePierrePath, FAKE_PIERRE)
  await Bun.write(fakeWorkerPath, FAKE_WORKER)
  await Bun.write(fakeWrapperPath, FAKE_PIERRE_WRAPPER)

  const fixtureMocks: Plugin = {
    name: "fixture-code-mocks",
    // Runs ahead of vite:resolve so the real @pierre/diffs is never bundled.
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !importer.startsWith(uiRoot)) return null
      if (source === "@pierre/diffs") return fakePierrePath
      if (/^..\/pierre\/worker(\.ts)?$/.test(source)) return fakeWorkerPath
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
import { Code } from ${JSON.stringify(codePath)}

const [wrapper, setWrapper] = createSignal<{ file: any; renderRange: any }>({
  file: { name: "src/foo.ts", contents: "const a = 1\\n", cacheKey: "k1" },
  renderRange: { startingLine: 0, totalLines: Infinity, bufferBefore: 0, bufferAfter: 0 },
})

const root = document.querySelector("#root")!
render(
  () => (
    <div id="code-host">
      <Code file={wrapper().file} renderRange={wrapper().renderRange} overflow="scroll" />
    </div>
  ),
  root,
)

;(globalThis as any).__codeHarness = {
  reset: () => {
    const state = (globalThis as any).__codeFixtureState
    ;(globalThis as any).__codeBaseline = { constructed: state.constructed, render: state.render }
  },
  churnSame: () =>
    setWrapper((current) => ({
      file: { name: current.file.name, contents: current.file.contents, cacheKey: current.file.cacheKey },
      renderRange: { ...current.renderRange },
    })),
  churnChange: () =>
    setWrapper((current) => ({
      file: {
        name: current.file.name,
        contents: current.file.contents + ${JSON.stringify("// changed\n")},
        cacheKey: "k2",
      },
      renderRange: { ...current.renderRange },
    })),
  counts: () => {
    const state = (globalThis as any).__codeFixtureState
    const baseline = (globalThis as any).__codeBaseline ?? { constructed: 0, render: 0 }
    return { constructed: state.constructed - baseline.constructed, render: state.render - baseline.render }
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
  harness = (globalThis as unknown as { __codeHarness: CodeHarness }).__codeHarness
  // The Code component renders synchronously during mount, so capture the
  // post-mount baseline before the first test; counts() then reports only
  // renders caused by the test itself.
  harness.reset()
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("Code value-stable rendering", () => {
  test("mounts the pierre view once", () => {
    expect(rendered("#code-host")).not.toBeNull()
    expect(harness.counts()).toEqual({ constructed: 0, render: 0 })
  })

  test("wrapper churn around unchanged file contents and render range does not re-render", async () => {
    harness.reset()
    await wait(0)
    expect(harness.counts()).toEqual({ constructed: 0, render: 0 })

    harness.churnSame()
    await wait(0)
    expect(harness.counts()).toEqual({ constructed: 0, render: 0 })

    harness.churnSame()
    await wait(0)
    expect(harness.counts()).toEqual({ constructed: 0, render: 0 })
  })

  test("re-renders only when file contents actually change", async () => {
    harness.reset()
    await wait(0)
    expect(harness.counts()).toEqual({ constructed: 0, render: 0 })

    harness.churnChange()
    await wait(0)
    expect(harness.counts()).toEqual({ constructed: 0, render: 1 })
    expect(rendered("#code-host")).not.toBeNull()
  })
})

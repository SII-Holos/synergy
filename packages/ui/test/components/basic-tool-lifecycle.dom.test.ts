import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { JSDOM } from "jsdom"
import { build, type Plugin } from "vite"
import solidPlugin from "vite-plugin-solid"

interface CodeHarness {
  multiedit: () => void
  locale: (locale: string) => void
  dispose: () => void
  requests: () => unknown[]
  churnSame: () => void
  counts: () => { constructed: number; render: number; cleaned: number; connected: number }
}

let fixtureDirectory: string
let dom: JSDOM
let harness: CodeHarness

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const FAKE_PIERRE = `
type FixtureState = { constructed: number; render: number; cleaned: number }
const state = ((globalThis as any).__codeFixtureState ??= { constructed: 0, render: 0, cleaned:0 }) as FixtureState

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
  cleanUp(): void { state.cleaned++ }
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
  const fakeMessagePath = path.join(fixtureDirectory, "message-part.tsx")
  await Bun.write(
    fakeMessagePath,
    `export { ToolRegistry } from "${path.join(uiRoot, "src/components/tool-registry-lazy.ts")}"; export const getDiagnostics = () => []; export const DiagnosticsDisplay = () => null; export const getDirectory = (path: string) => path`,
  )
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
      if (source.endsWith("/message-part")) return fakeMessagePath
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
import { render } from "solid-js/web"
import { createSignal, ErrorBoundary, Show } from "solid-js"
import { ToolRegistry } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/components/tool-registry-lazy.ts"))}
import ${JSON.stringify(path.resolve(import.meta.dir, "../../src/components/tool/renders/file-ops.tsx"))}
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/testing/i18n.tsx"))}
import { ToolFilePreview, ToolPatchPreview } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/components/tool/content-preview.tsx"))}
import { ResourceOpenProvider } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/context/resource-open.tsx"))}
import { BasicTool } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/components/basic-tool.tsx"))}
import { Code } from ${JSON.stringify(codePath)}
const [revision, setRevision] = createSignal(0)
const [multi, setMulti] = createSignal(false)
const Multi = ToolRegistry.render("multiedit")!
const requests: unknown[] = []
const i18n = setupI18n()
i18n.load({en:{}, "zh-CN":{"ui.toolContent.openFile":"打开当前文件","ui.toolContent.openReview":"在审阅中打开"}})
const dispose = render(() => <I18nProvider i18n={i18n}><ResourceOpenProvider value={{open:()=>false,openAttachment:()=>false,resolveWorkspacePath:path=>path,openWorkspaceSource:path=>{requests.push({path});return true},openToolReview:target=>{requests.push(target);return true}}}><div id="multi"><ErrorBoundary fallback={error=><div data-error>{error.message}</div>}><Show when={multi()}><Multi tool="multiedit" status="completed" defaultOpen input={{filePath:"file.ts"}} metadata={{results:[{filediff:{file:"file.ts",preview:"+historic"}}]}} /></Show></ErrorBoundary></div><div id="preview-host"><ToolFilePreview content={"line\\n".repeat(1000)} path="file.ts"/><ToolPatchPreview patch={"+new\\n".repeat(1000)} path="file.ts" tool={{sessionId:"session",messageId:"message",partId:"part"}}/></div><div id="large-code"><Code file={{name:"large.ts", contents:"x".repeat(100000)}} /></div><BasicTool trigger={{icon:"file", title:"Probe", subtitle:String(revision())}} status="completed" defaultOpen={false}><Code file={{name:"probe.ts", contents:"const a = 1",cacheKey:"probe"}} /></BasicTool></ResourceOpenProvider></I18nProvider>, document.querySelector("#root")!)
;(globalThis as any).__codeHarness = {multiedit:()=>setMulti(true),locale:locale=>i18n.activate(locale), counts:()=>({...((globalThis as any).__codeFixtureState), connected:document.querySelectorAll('[data-component="fake-pierre-render"]').length}), requests:()=>requests, reset:()=>{}, churnSame:()=>setRevision(n=>n+1), churnChange:()=>{}, dispose}
`,
  )

  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [fixtureMocks, solidPlugin()],
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
    getComputedStyle: (el: Element) => {
      const style = window.getComputedStyle(el)
      if (!style.animationName) style.animationName = "none"
      return style
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  })

  await import(`${pathToFileURL(path.join(fixtureDirectory, "dist", "fixture.js")).href}?test=${Date.now()}`)
  harness = (globalThis as unknown as { __codeHarness: CodeHarness }).__codeHarness
}, 60000)

afterAll(async () => {
  dom?.window.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("tool result demand and previews", () => {
  test("closed tools do no renderer work and release it when closing", async () => {
    expect(harness.counts()).toEqual({ constructed: 0, render: 0, cleaned: 0, connected: 0 })
    harness.churnSame()
    await wait(0)
    expect(harness.counts().constructed).toBe(0)
    const trigger = document.querySelector<HTMLButtonElement>('button[data-slot="collapsible-trigger"]')!
    trigger.click()
    await wait(20)
    expect(harness.counts()).toEqual({ constructed: 1, render: 1, cleaned: 0, connected: 1 })
    trigger.click()
    await wait(40)
    expect(harness.counts()).toEqual({ constructed: 1, render: 1, cleaned: 1, connected: 0 })
  })

  test("legacy multi-edit reads a keyed diff object without invoking it", async () => {
    harness.multiedit()
    await wait(20)
    expect(document.querySelector("#multi [data-error]")?.textContent).toBeUndefined()
    expect(document.querySelector("#multi pre")?.textContent).toBe("+historic")
  })

  test("bounded previews open a file or the exact historical tool review", () => {
    const blocks = document.querySelectorAll("#preview-host pre")
    expect(blocks.length).toBe(2)
    for (const block of blocks) expect(block.textContent!.length).toBeLessThan(8192)
    expect(blocks[0]!.textContent!.split("\n").length).toBe(80)
    expect(document.querySelectorAll("#preview-host [data-slot=diff-preview-line]").length).toBe(80)
    const buttons = document.querySelectorAll<HTMLButtonElement>("#preview-host button")
    expect(buttons[0]!.textContent).toBe("Open current file")
    expect(buttons[1]!.textContent).toBe("Open in Review")
    expect(document.querySelector("#large-code pre")!.textContent!.length).toBe(100000)
    harness.locale("zh-CN")
    expect(buttons[0]!.textContent).toBe("打开当前文件")
    expect(buttons[1]!.textContent).toBe("在审阅中打开")
    buttons[0]!.click()
    buttons[1]!.click()
    expect(harness.requests()).toEqual([
      { path: "file.ts" },
      { sessionID: "session", messageID: "message", partID: "part", path: "file.ts" },
    ])
    harness.dispose()
  })
})

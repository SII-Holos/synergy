import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import { testOptions } from "../../../script/test-options"

let browser: Browser
let page: Page
let server: ViteDevServer
let fixtureDirectory: string
let baseUrl: string
const pageErrors: Error[] = []

const componentPath = path.resolve(import.meta.dir, "../../../src/components/file-workbench/content.tsx")
const appSrc = path.resolve(import.meta.dir, "../../../src")

interface RetainedInputWindow extends Window {
  fixture: {
    setActive(active: boolean): void
    holdSaves(hold: boolean): void
    finishSaves(): void
    saves: { path: string; content: string }[]
    modes: { path: string; mode: string }[]
    keys: { key: string; prevented: boolean }[]
    wraps: { workspace: string; path: string; value: boolean }[]
    draftChanges: { operation: string; path: string }[]
    opens: {
      workspace: { id: string; generation: number; scopeID: string; type: string; path: string }
      path: string
      options: { directory: boolean }
    }[]
    setRoots(roots: { id: string; generation: number; scopeID: string; type: string; path: string }[]): void
  }
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(import.meta.dir, ".html-preview-fixture-"))
  const fileStubPath = path.join(fixtureDirectory, "file-stub.ts")
  const promptStubPath = path.join(fixtureDirectory, "prompt-stub.ts")
  const platformStubPath = path.join(fixtureDirectory, "platform-stub.ts")
  const sdkStubPath = path.join(fixtureDirectory, "sdk-stub.ts")
  const localeStubPath = path.join(fixtureDirectory, "locale-stub.ts")

  await Promise.all([
    Bun.write(
      path.join(fixtureDirectory, "index.html"),
      '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      fileStubPath,
      `
        import { createComponent, createContext, createSignal, useContext } from "solid-js"
        import { createStore } from "solid-js/store"
        const query = new URLSearchParams(location.search)
        export const capturedWorkspace = { id: "wsp_demo", generation: 1, scopeID: "home",
          path: query.has("worktree") ? "/workspaces/.synergy/worktrees/synergy-session-captured" : "/workspace/demo",
          type: query.has("worktree") ? "worktree" : "directory", name: query.get("name") ?? undefined }
        const WorkspaceContext = createContext()
        const [drafts, setDrafts] = createStore({})
        const [documents, setDocuments] = createStore({})
        const [modes, setModes] = createStore({})
        const [wrap, setWrap] = createStore({})
        const [navigation, setNavigation] = createStore({ open: false, width: 260 })
        const rebound = { ...capturedWorkspace, generation: 2, path: "/workspace/demo-rebound" }
        const [roots, setRoots] = createSignal([
          { id: "wsp_team", generation: 1, scopeID: "home", path: "/workspace/team", type: "directory", name: "Team workspace" },
          rebound, rebound,
        ])
        const content = path => documents[path] ?? "<p>source</p>"
        const pending = []
        let held = false
        export const saves = [], modeChanges = [], wraps = [], draftChanges = [], opens = []
        export { setRoots }
        export const holdSaves = value => { held = value }
        export const finishSaves = () => { for (const finish of pending.splice(0)) finish() }
        export const FileWorkspaceProvider = props => createComponent(WorkspaceContext.Provider, {
          value: props.workspace, get children() { return props.children },
        })
        export const useProjectFiles = () => ({ roots, search: async () => [], open: async (workspace, path, options) => {
          opens.push({ workspace, path, options })
          return undefined
        } })
        export const useFile = () => {
          const workspace = useContext(WorkspaceContext) ?? capturedWorkspace
          const wrapKey = path => JSON.stringify([workspace.id, workspace.generation, path])
          return {
          draft: {
            backupUnavailable: () => false,
            get: path => drafts[path],
            dirty: path => !!drafts[path] && drafts[path].content !== drafts[path].baseContent,
            begin: path => { draftChanges.push({ operation: "begin", path }); setDrafts(path, { baseContent: content(path), content: content(path), expectedVersion: "version-1" }) },
            update: (path, value) => { draftChanges.push({ operation: "update", path }); setDrafts(path, "content", value) },
            discard: path => { draftChanges.push({ operation: "discard", path }); setDrafts(path, undefined) },
          },
          workspace,
          reference: () => ({ workspaceID: workspace.id, workspaceGeneration: workspace.generation }),
          resourceKey: "demo",
          activePath: () => query.get("path") ?? "",
          navigation: () => undefined,
          get: path => ({
            loading: false,
            stale: false,
            deleted: false,
            content: { kind: "text", content: content(path), contentVersion: "version-1" },
            version: { mtime: 1725000000, size: 128 },
          }),
          load: async () => {},
          save: async (path, value) => {
            saves.push({ path, content: value })
            if (held) await new Promise(resolve => pending.push(resolve))
            setDocuments(path, value)
            if (drafts[path]?.content === value) setDrafts(path, undefined)
            else if (drafts[path]) setDrafts(path, "baseContent", value)
          },
          normalize: (value) => value,
          openWorkspaceFile: async () => {},
          view: {
            mode: path => modes[path],
            setMode: (path, mode) => { modeChanges.push({ path, mode }); setModes(path, mode) },
            wordWrap: path => wrap[wrapKey(path)] ?? true,
            setWordWrap: (path, value) => { wraps.push({ workspace: workspace.id + "@" + workspace.generation, path, value }); setWrap(wrapKey(path), value) },
            selectedLines: () => undefined,
            imageScaleMode: () => "fit",
            setImageScaleMode: () => {},
          },
          pdf: { get: () => undefined, load: async () => {} },
          explorer: {
            open: () => navigation.open, width: () => navigation.width,
            setWidth: value => setNavigation("width", value), setOpen: value => setNavigation("open", value),
            reveal: async () => {}, directory: () => ({ items: [], loading: false }), node: () => undefined,
            expanded: () => [], expandingAll: () => false, isExpanded: () => false, setExpanded() {},
            showHidden: () => false, setShowHidden() {}, loadChildren: async () => {}, refresh() {},
            expandAll: async () => {}, collapseAll() {},
          },
        } }
      `,
    ),
    Bun.write(promptStubPath, `export const usePrompt = () => ({ context: { add: () => {} } })`),
    Bun.write(
      platformStubPath,
      `
        export const usePlatform = () => ({
          platform: "web",
          openLink: () => {},
        })
      `,
    ),
    // Simulates bun dev: the SDK base points at the server port (:4096) while
    // the app page is served from the Vite dev server. The preview iframe must
    // fall back to the app origin so X-Frame-Options: SAMEORIGIN passes.
    Bun.write(
      sdkStubPath,
      `export const useSDK = () => ({ url: "http://127.0.0.1:4096", scopeID: "home", directory: undefined })`,
    ),
    Bun.write(
      localeStubPath,
      `
        export const useLocale = () => ({ i18n: {}, fmt: { number: (value) => String(value), relative: () => "Today" } })
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "source-stub.tsx"),
      `
        import { onMount } from "solid-js"
        import { useFile } from "@/context/file"
        export function FileSourceView(props) {
          const file = useFile()
          let editor
          onMount(() => props.onRegister?.({
            getContent: () => editor.value,
            applyContent: value => { editor.value = value },
          }))
          return <div class="file-source-view"><textarea ref={editor} aria-label={props.path + " source"}
            wrap={props.wordWrap ? "soft" : "off"}
            value={file.draft.get(props.path)?.content ?? props.content} readOnly={!props.editable}
            onInput={event => file.draft.update(props.path, event.currentTarget.value)} /></div>
        }
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "note-stub.ts"),
      `
        import { createStore } from "solid-js/store"
        const [navigation, setNavigation] = createStore({ open: true, width: 260 })
        const capabilities = { features: ["note"] }
        export const useGlobalSDK = () => ({
          capabilities: { current: () => capabilities, has: id => capabilities.features.includes(id) },
          event: { listen: () => () => {} },
          client: { note: { listMeta: async () => ({ data: [{ scopeID: "home", scopeType: "home", notes: [{
            id: "note-first", title: "First note", kind: "note", time: { created: 1725000000, updated: 1725000000 },
          }] }] }) } },
        })
        export const useGlobalSync = () => ({ reconnectVersion: () => 0, data: { scope: [] } })
        export const useSync = () => ({})
        export const useParams = () => ({ dir: "aG9tZQ" })
        export const useWorkbenchPanels = () => ({})
        export const useNoteDocuments = () => ({ navigation: () => ({
          state: navigation, setOpen: value => setNavigation("open", value), setWidth: value => setNavigation("width", value),
        }) })
        export const useConfirm = () => ({})
        export const TIPTAP_STYLES = ""
        export const DocumentEditorCore = () => null
      `,
    ),
    Bun.write(
      path.join(fixtureDirectory, "main.tsx"),
      `
        import { createSignal, lazy, Show } from "solid-js"
        import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
        import { render } from "solid-js/web"
        import { setupI18n } from "@lingui/core"
        import { I18nProvider } from "@lingui/solid"
        import "@ericsanchezok/synergy-ui/styles"
        import { FileWorkbenchContent } from ${JSON.stringify(`/@fs/${componentPath}`)}
        const NotePanel = lazy(() => import(${JSON.stringify(`/@fs/${appSrc}/components/note/panel.tsx`)}).then(module => ({ default: module.NotePanel })))
        import { ViewActivityProvider } from "@/context/view-residency"
        import { saves, modeChanges, holdSaves, finishSaves, wraps, draftChanges, opens, setRoots, capturedWorkspace } from "./file-stub"

        const i18n = setupI18n({ locale: "en" })
        const query = new URLSearchParams(location.search)
        const file = query.get("path") ?? ""
        const [active, setActive] = createSignal(true)
        const keys = []
        window.addEventListener("keydown", event => keys.push({ key: event.key, prevented: event.defaultPrevented }))
        window.fixture = { setActive, saves, modes: modeChanges, holdSaves, finishSaves, keys, wraps, draftChanges, opens, setRoots }
        const tab = path => ({ id: path, panelId: "file", title: path, resourceId: "wsp_demo@1/" + path,
          state: { workspace: capturedWorkspace } })
        render(() => <I18nProvider i18n={i18n}><DialogProvider>
          <style>{"[data-retained-owner] { height: 240px } [data-retained-owner][hidden] { display: none }"}</style>
          <input aria-label="Other editor" />
          <ViewActivityProvider active={active}>
            <section data-retained-owner data-ui-part="resource-panel" hidden={!active()} inert={!active()}>
              <Show when={query.has("notes")} fallback={<FileWorkbenchContent tab={tab(file)} onRequestClose={() => {}} />}>
                <NotePanel />
              </Show>
            </section>
          </ViewActivityProvider>
          <Show when={query.get("second")}>{path => <section data-second-owner style="height:240px">
            <ViewActivityProvider active={() => true}><FileWorkbenchContent tab={tab(path())} onRequestClose={() => {}} /></ViewActivityProvider>
          </section>}</Show>
        </DialogProvider></I18nProvider>, document.querySelector("#root"))
      `,
    ),
  ])

  server = await createServer({
    configFile: false,
    root: fixtureDirectory,
    plugins: [
      {
        name: "retained-input-fixture",
        enforce: "pre",
        resolveId(id, importer) {
          if (id === "./source-view" && importer === componentPath)
            return path.join(fixtureDirectory, "source-stub.tsx")
          if (id === "./documents" && importer === path.join(appSrc, "components/note/panel.tsx"))
            return path.join(fixtureDirectory, "note-stub.ts")
        },
      },
      solidPlugin(),
      {
        name: "raw-file-fixture",
        // Simulates the backend /workspace/files/raw route (same headers the
        // real server sends: XFO SAMEORIGIN + sandbox CSP) on the same origin
        // as the Vite app, standing in for the /workspace dev proxy.
        configureServer(devServer) {
          devServer.middlewares.use("/workspace/files/raw/", (_req, res) => {
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "x-frame-options": "SAMEORIGIN",
              "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
            })
            res.end('<!doctype html><html><body><p id="doc">rendered</p></body></html>')
          })
        },
      },
    ],
    resolve: {
      alias: [
        { find: /^@\/context\/file$/, replacement: fileStubPath },
        { find: /^@\/context\/prompt$/, replacement: promptStubPath },
        { find: /^@\/context\/platform$/, replacement: platformStubPath },
        { find: /^@\/context\/sdk$/, replacement: sdkStubPath },
        { find: /^@\/context\/locale$/, replacement: localeStubPath },
        {
          find: /^@\/context\/(global-sdk|global-sync|sync|session-route|workbench)$/,
          replacement: path.join(fixtureDirectory, "note-stub.ts"),
        },
        {
          find: /^@\/components\/(dialog\/confirm-dialog|note\/document-editor-core)$/,
          replacement: path.join(fixtureDirectory, "note-stub.ts"),
        },
        {
          find: "@ericsanchezok/synergy-plugin/theme",
          replacement: path.resolve(import.meta.dir, "../../../../..", "packages/plugin/src/theme/index.ts"),
        },
        { find: "@", replacement: appSrc },
      ],
    },
    optimizeDeps: {
      include: [
        "solid-js",
        "solid-js/web",
        "solid-js/store",
        "solid-js/jsx-runtime",
        "@lingui/core",
        "@lingui/solid",
        "zod",
        "fuzzysort",
      ],
      noDiscovery: true,
    },
    cacheDir: path.join(fixtureDirectory, ".vite"),
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")

  const resolved = server.resolvedUrls?.local[0]
  if (!resolved) throw new Error("Expected Vite test server URL")
  baseUrl = resolved

  browser = await chromium.launch({ headless: true })
}, testOptions.isolatedTimeoutMs)

beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on("pageerror", (error) => pageErrors.push(error))
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(new Error(message.text()))
  })
  page.on("response", (response) => {
    if (response.status() >= 400) pageErrors.push(new Error(`HTTP ${response.status()} for ${response.url()}`))
  })
})

afterEach(async () => {
  await page?.close()
  expect(pageErrors.splice(0).map((error) => error.message)).toEqual([])
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe("file workbench HTML preview iframe", () => {
  beforeEach(async () => {
    await page.goto(`${baseUrl}?path=test.html`)
    await page.waitForSelector(".file-html-preview", { timeout: 30000 })
  })

  test("points the iframe at the app origin even when the SDK base is cross-origin", async () => {
    const src = await page.locator(".file-html-preview").getAttribute("src")
    const appOrigin = new URL(baseUrl).origin
    expect(src).toMatch(new RegExp(`^${appOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/workspace/files/raw/`))
    expect(src).not.toContain("127.0.0.1:4096")
  })

  test("keeps the sandbox attribute so the document stays confined", async () => {
    const sandbox = await page.locator(".file-html-preview").getAttribute("sandbox")
    expect(sandbox).toBe("allow-scripts")
  })

  test("loads the sandboxed document inside the same-origin frame", async () => {
    const doc = page.frameLocator(".file-html-preview").locator("#doc")
    await doc.waitFor({ state: "attached", timeout: 30000 })
    // The document is sandboxed into an opaque origin (no allow-same-origin),
    // so the parent cannot read contentDocument; frameLocator queries the
    // frame DOM directly. The text is static, so attached implies rendered.
    expect(await doc.textContent()).toBe("rendered")
  }, 60000)
})

describe("file toolbar ownership and layout", () => {
  test("keeps only parent directories and opens origins through protected directory navigation", async () => {
    await page.goto(`${baseUrl}?path=docs/guides/guide.html`)
    const owner = page.locator("[data-retained-owner]")
    const toolbar = owner.locator(".file-workbench-toolbar")
    await toolbar.waitFor()
    expect(await toolbar.textContent()).not.toContain("guide.html")
    expect(await toolbar.textContent()).not.toContain("/workspace/demo")
    expect(await toolbar.getByRole("button").first().getAttribute("aria-controls")).toBe(
      "file-navigation-docs/guides/guide.html",
    )
    const origin = toolbar.getByRole("button", { name: "Workspace: demo", exact: true })
    expect(await origin.count()).toBe(1)
    const parents = toolbar.getByRole("navigation", { name: "File path" })
    expect(await parents.textContent()).toContain("docs")
    expect(await parents.textContent()).toContain("guides")
    await origin.click()
    expect(await page.getByRole("option").allTextContents()).toEqual([
      "/workspace/demo",
      "/workspace/team",
      "/workspace/demo-rebound",
    ])
    expect(await page.getByRole("option", { name: "/workspace/demo", exact: true }).getAttribute("aria-selected")).toBe(
      "true",
    )
    await page.getByRole("option", { name: "/workspace/demo-rebound", exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.opens)).toEqual([
      {
        workspace: {
          id: "wsp_demo",
          generation: 2,
          scopeID: "home",
          path: "/workspace/demo-rebound",
          type: "directory",
        },
        path: "",
        options: { directory: true },
      },
    ])
    expect(await origin.textContent()).toBe("demo")
    expect(await owner.locator(".file-html-preview").getAttribute("src")).toContain(
      "/wsp_demo/1/docs/guides/guide.html",
    )
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.draftChanges)).toEqual([])
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toEqual([])
    await page.evaluate(() =>
      (window as unknown as RetainedInputWindow).fixture.setRoots([
        { id: "wsp_elsewhere", generation: 4, scopeID: "home", path: "/workspace/elsewhere", type: "directory" },
      ]),
    )
    expect(await origin.textContent()).toBe("demo")
    await origin.click()
    expect(await page.getByRole("option", { name: "/workspace/demo", exact: true }).getAttribute("aria-selected")).toBe(
      "true",
    )
  })

  test("uses a short named origin or Working copy without hiding the original path options", async () => {
    await page.goto(`${baseUrl}?path=test.html&worktree`)
    const toolbar = page.locator(".file-workbench-toolbar")
    await toolbar.waitFor()
    expect(await toolbar.textContent()).not.toContain("synergy-session-captured")
    const origin = toolbar.getByRole("button", { name: "Workspace: Working copy", exact: true })
    expect(await origin.count()).toBe(1)
    await origin.click()
    expect(
      await page
        .getByRole("option", { name: "/workspaces/.synergy/worktrees/synergy-session-captured", exact: true })
        .count(),
    ).toBe(1)
    await page.goto(`${baseUrl}?path=test.html&name=Design%20workspace`)
    await page.locator(".file-workbench-toolbar").waitFor()
    expect(await page.getByRole("button", { name: "Workspace: Design workspace", exact: true }).count()).toBe(1)
  })

  test("wrap toggles preserve the live editor, selection and unsaved draft", async () => {
    await page.goto(`${baseUrl}?path=wrapped.html`)
    const owner = page.locator("[data-retained-owner]")
    await owner.getByRole("button", { name: "Source", exact: true }).click()
    const wrap = owner.getByRole("button", { name: "Word wrap", exact: true })
    expect(await wrap.count()).toBe(1)
    expect(await wrap.getAttribute("aria-pressed")).toBe("true")
    await owner.getByRole("button", { name: "Edit", exact: true }).click()
    const editor = owner.getByRole("textbox", { name: "wrapped.html source" })
    await editor.fill("Long unsaved content ".repeat(80))
    await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(7, 19))
    const original = await editor.elementHandle()
    const draftChanges = await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.draftChanges)
    await wrap.click()
    expect(await wrap.getAttribute("aria-pressed")).toBe("false")
    expect(await editor.getAttribute("wrap")).toBe("off")
    expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true)
    expect(
      await editor.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]),
    ).toEqual([7, 19])
    await editor.focus()
    await page.keyboard.press("Alt+z")
    expect(await wrap.getAttribute("aria-pressed")).toBe("true")
    expect(await editor.getAttribute("wrap")).toBe("soft")
    await owner.getByRole("button", { name: "Workspace: demo", exact: true }).click()
    await page.getByRole("option", { name: "/workspace/team", exact: true }).click()
    expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true)
    expect(await owner.getByRole("button", { name: "Workspace: demo", exact: true }).count()).toBe(1)
    expect(await editor.inputValue()).toBe("Long unsaved content ".repeat(80))
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.draftChanges)).toEqual(
      draftChanges,
    )
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toEqual([])
    expect(await owner.getByRole("button", { name: "Save", exact: true }).isEnabled()).toBe(true)
  })

  test("Alt+Z changes only the focused active source and leaves other inputs and previews alone", async () => {
    await page.goto(`${baseUrl}?path=first.html&second=second.html`)
    const first = page.locator("[data-retained-owner]")
    const second = page.locator("[data-second-owner]")
    for (const owner of [first, second]) {
      await owner.getByRole("button", { name: "Source", exact: true }).click()
    }
    const firstWrap = first.getByRole("button", { name: "Word wrap", exact: true })
    const secondWrap = second.getByRole("button", { name: "Word wrap", exact: true })
    expect(await firstWrap.count()).toBe(1)
    await first.getByRole("textbox").focus()
    await page.keyboard.press("Alt+z")
    expect(await firstWrap.getAttribute("aria-pressed")).toBe("false")
    expect(await secondWrap.getAttribute("aria-pressed")).toBe("true")
    await secondWrap.focus()
    await page.keyboard.press("Alt+z")
    expect(await secondWrap.getAttribute("aria-pressed")).toBe("false")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.wraps)).toEqual([
      { workspace: "wsp_demo@1", path: "first.html", value: false },
      { workspace: "wsp_demo@1", path: "second.html", value: false },
    ])
    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(false))
    const external = page.getByRole("textbox", { name: "Other editor" })
    await external.focus()
    await page.keyboard.press("Alt+z")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.keys.at(-1)?.prevented)).toBe(
      false,
    )
    await second.getByRole("button", { name: "Preview", exact: true }).click()
    expect(await secondWrap.isDisabled()).toBe(true)
    await second.getByRole("button", { name: "Source", exact: true }).focus()
    await page.keyboard.press("Alt+z")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.keys.at(-1)?.prevented)).toBe(
      false,
    )
    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(true))
    await first.getByRole("button", { name: "Show files list", exact: true }).click()
    const search = first.getByRole("searchbox")
    await search.focus()
    await page.keyboard.press("Alt+z")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.keys.at(-1)?.prevented)).toBe(
      false,
    )
    const editor = first.getByRole("textbox")
    await editor.focus()
    await editor.dispatchEvent("keydown", {
      key: "z",
      altKey: true,
      bubbles: true,
      cancelable: true,
      isComposing: true,
    })
    await editor.evaluate((element) =>
      element.addEventListener("keydown", (event) => event.preventDefault(), { once: true }),
    )
    await editor.dispatchEvent("keydown", { key: "z", altKey: true, bubbles: true, cancelable: true })
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.wraps)).toHaveLength(2)
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toEqual([])
  })

  test("a 375px pane keeps editing controls reachable and reuses the resource-scoped navigator", async () => {
    await page.goto(`${baseUrl}?path=docs/test.html&name=A%20very%20long%20workspace%20origin%20name`)
    const owner = page.locator("[data-retained-owner]")
    await owner.evaluate((element: HTMLElement) => {
      element.style.width = "375px"
      element.style.height = "420px"
    })
    await owner.getByRole("button", { name: "Source", exact: true }).click()
    await owner.getByRole("button", { name: "Edit", exact: true }).click()
    await owner.getByRole("textbox").fill("Narrow unsaved draft")
    const toolbar = owner.locator(".file-workbench-toolbar")
    expect(await toolbar.getByRole("button", { name: "Word wrap", exact: true }).count()).toBe(1)
    const bounds = await toolbar.evaluate((element) => {
      const toolbar = element.getBoundingClientRect()
      return [...element.querySelectorAll<HTMLButtonElement>("button")]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => {
          const rect = button.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          return {
            label: button.getAttribute("aria-label") ?? button.textContent,
            hit: hit === button || (!!hit && button.contains(hit)),
            contained:
              rect.left >= toolbar.left &&
              rect.right <= toolbar.right &&
              rect.top >= toolbar.top &&
              rect.bottom <= toolbar.bottom,
            width: rect.width,
            height: rect.height,
          }
        })
    })
    for (const control of bounds) {
      expect(control.contained, control.label ?? "toolbar control").toBe(true)
      expect(control.hit, control.label ?? "toolbar hit target").toBe(true)
      expect(control.width).toBeGreaterThanOrEqual(24)
      expect(control.height).toBeGreaterThanOrEqual(24)
    }
    expect(await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    const toggle = owner.locator("[data-workspace-navigation-toggle]")
    expect(await toggle.getAttribute("aria-label")).toBe("Show files list")
    expect(await toggle.getAttribute("aria-expanded")).toBe("false")
    await toggle.click()
    const drawer = owner.getByRole("dialog", { name: "Files", exact: true })
    await drawer.waitFor()
    await page.waitForFunction(() =>
      document.querySelector("[data-workspace-navigation]")?.contains(document.activeElement),
    )
    await drawer.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })
    expect(await toggle.getAttribute("aria-expanded")).toBe("true")
    expect(await owner.locator("[data-workspace-navigation]").count()).toBe(1)
    const geometry = await owner.evaluate((element) => {
      const main = element.querySelector(".file-workbench-main")!.getBoundingClientRect()
      const drawer = element.querySelector("[data-workspace-navigation]")!.getBoundingClientRect()
      const explorer = element.querySelector(".file-explorer")!.getBoundingClientRect()
      const overlay = element.querySelector(".workspace-navigator-overlay")!.getBoundingClientRect()
      return {
        drawerLeft: drawer.left - main.left,
        explorerLeft: explorer.left - drawer.left,
        explorerWidth: explorer.width - drawer.width,
        overlayWidth: overlay.width - main.width,
        overlayTop: overlay.top - main.top,
      }
    })
    for (const [label, value] of Object.entries(geometry)) expect(Math.abs(value), label).toBeLessThanOrEqual(1)
    await page.keyboard.press("Escape")
    await drawer.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.matches("[data-workspace-navigation-toggle]"))
    await drawer.waitFor({ state: "detached" })
    expect(await toggle.getAttribute("aria-expanded")).toBe("false")
    expect(await owner.getByRole("textbox").inputValue()).toBe("Narrow unsaved draft")
    await page.setViewportSize({ width: 1024, height: 600 })
    await owner.evaluate((element: HTMLElement) => {
      element.style.width = "800px"
    })
    await owner.getByRole("complementary", { name: "Files", exact: true }).first().waitFor()
    const split = await owner.evaluate((element) => {
      const main = element.querySelector(".file-workbench-main")!.getBoundingClientRect()
      const navigation = element.querySelector("[data-workspace-navigation]")!.getBoundingClientRect()
      const explorer = element.querySelector(".file-explorer")!.getBoundingClientRect()
      const viewer = element.querySelector(".file-viewer")!.getBoundingClientRect()
      return {
        left: navigation.left - main.left,
        adjacent: viewer.left - navigation.right,
        fills: explorer.width - navigation.width,
        right: viewer.right - main.right,
      }
    })
    for (const [label, value] of Object.entries(split)) expect(Math.abs(value), label).toBeLessThanOrEqual(1)
    expect(await owner.getByRole("separator", { name: "Resize navigation", exact: true }).count()).toBe(1)
    expect(await owner.locator('[data-component="resize-handle"]').count()).toBe(1)
    expect(await owner.locator(".workspace-navigator-drawer").count()).toBe(0)
    expect(await toggle.getAttribute("aria-expanded")).toBe("true")
  })
})

describe("retained panel keyboard ownership", () => {
  test.each(["Meta", "Control"])("%s+S saves only the restored active draft", async (modifier) => {
    await page.goto(`${baseUrl}?path=draft.html`)
    const owner = page.locator("[data-retained-owner]")
    await owner.getByRole("button", { name: "Source", exact: true }).click()
    await owner.getByRole("button", { name: "Edit", exact: true }).click()
    const editor = owner.getByRole("textbox", { name: "draft.html source" })
    await editor.fill("Retained unsaved draft")
    const original = await editor.elementHandle()
    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(false))
    expect(await owner.isVisible()).toBe(false)
    expect(await original!.evaluate((element) => element.isConnected && !!element.closest("[inert]"))).toBe(true)
    await page.getByRole("textbox", { name: "Other editor" }).focus()
    await page.keyboard.press(`${modifier}+s`)
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toEqual([])
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.keys.at(-1)?.prevented)).toBe(
      false,
    )

    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(true))
    expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true)
    expect(await editor.inputValue()).toBe("Retained unsaved draft")
    expect(await editor.evaluate((element: HTMLTextAreaElement) => element.readOnly)).toBe(false)
    await editor.focus()
    await page.keyboard.press(`${modifier}+s`)
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toEqual([
      { path: "draft.html", content: "Retained unsaved draft" },
    ])
    await owner.getByRole("button", { name: "Edit", exact: true }).waitFor()
    expect(await editor.inputValue()).toBe("Retained unsaved draft")
  })

  test.each(["Meta", "Control"])("%s+Shift+V leaves an inactive preview unchanged", async (modifier) => {
    await page.goto(`${baseUrl}?path=preview.html`)
    const owner = page.locator("[data-retained-owner]")
    const source = owner.getByRole("button", { name: "Source", exact: true })
    await source.focus()
    await page.keyboard.press(`${modifier}+Shift+v`)
    expect(await source.getAttribute("aria-pressed")).toBe("true")
    const original = await owner.locator("textarea").elementHandle()
    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(false))
    await page.getByRole("textbox", { name: "Other editor" }).focus()
    await page.keyboard.press(`${modifier}+Shift+v`)
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.modes)).toEqual([
      { path: "preview.html", mode: "source" },
    ])
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.keys.at(-1)?.prevented)).toBe(
      false,
    )

    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(true))
    expect(await owner.locator("textarea").evaluate((element, previous) => element === previous, original)).toBe(true)
    await source.focus()
    await page.keyboard.press(`${modifier}+Shift+v`)
    expect(await owner.getByRole("button", { name: "Preview", exact: true }).getAttribute("aria-pressed")).toBe("true")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.modes)).toEqual([
      { path: "preview.html", mode: "source" },
      { path: "preview.html", mode: "preview" },
    ])
  })

  test("visible files respect the focused owner and leave other input shortcuts alone", async () => {
    await page.goto(`${baseUrl}?path=first.html&second=second.html`)
    const first = page.locator("[data-retained-owner]")
    const second = page.locator("[data-second-owner]")
    for (const [owner, content] of [
      [first, "First draft"],
      [second, "Second draft"],
    ] as const) {
      await owner.getByRole("button", { name: "Source", exact: true }).click()
      await owner.getByRole("button", { name: "Edit", exact: true }).click()
      await owner.getByRole("textbox").fill(content)
    }
    await page.keyboard.press("Meta+s")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toEqual([
      { path: "second.html", content: "Second draft" },
    ])
    expect(await first.getByRole("textbox").inputValue()).toBe("First draft")
    expect(await first.getByRole("button", { name: "Save", exact: true }).isEnabled()).toBe(true)

    await page.getByRole("textbox", { name: "Other editor" }).focus()
    await page.keyboard.press("Meta+s")
    await page.keyboard.press("Meta+Shift+v")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toHaveLength(1)
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.modes)).toHaveLength(2)
    expect(
      await page.evaluate(() =>
        (window as unknown as RetainedInputWindow).fixture.keys.slice(-2).map((key) => key.prevented),
      ),
    ).toEqual([false, false])

    const editor = first.getByRole("textbox")
    await editor.focus()
    await page.keyboard.press("Meta+Shift+v")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.modes)).toHaveLength(2)
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.keys.at(-1)?.prevented)).toBe(
      false,
    )
    await editor.evaluate((element) => element.addEventListener("keydown", (event) => event.preventDefault()))
    await editor.press("Meta+s")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toHaveLength(1)
    await first.getByRole("button", { name: "Source", exact: true }).focus()
    await page.keyboard.press("Control+s")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toEqual([
      { path: "second.html", content: "Second draft" },
      { path: "first.html", content: "First draft" },
    ])
  })

  test("an in-flight active save settles while hidden without discarding newer edits", async () => {
    await page.goto(`${baseUrl}?path=pending.html`)
    const owner = page.locator("[data-retained-owner]")
    await owner.getByRole("button", { name: "Source", exact: true }).click()
    await owner.getByRole("button", { name: "Edit", exact: true }).click()
    const editor = owner.getByRole("textbox")
    await editor.fill("Submitted draft")
    const original = await editor.elementHandle()
    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.holdSaves(true))
    await page.keyboard.press("Control+s")
    await owner.getByRole("button", { name: "Saving…", exact: true }).waitFor()
    await editor.fill("Newer unsaved draft")
    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(false))
    await page.getByRole("textbox", { name: "Other editor" }).focus()
    await page.keyboard.press("Control+s")
    await page.evaluate(() => {
      const fixture = (window as unknown as RetainedInputWindow).fixture
      fixture.holdSaves(false)
      fixture.finishSaves()
    })
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".file-edit-pill--save")?.disabled)
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toEqual([
      { path: "pending.html", content: "Submitted draft" },
    ])
    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(true))
    expect(await editor.evaluate((element, previous) => element === previous, original)).toBe(true)
    expect(await editor.inputValue()).toBe("Newer unsaved draft")
    expect(await editor.evaluate((element: HTMLTextAreaElement) => element.readOnly)).toBe(false)
    await editor.focus()
    await page.keyboard.press("Control+s")
    expect(await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.saves)).toEqual([
      { path: "pending.html", content: "Submitted draft" },
      { path: "pending.html", content: "Newer unsaved draft" },
    ])
    await owner.getByRole("button", { name: "Edit", exact: true }).waitFor()
  })

  test.each(["external editor", "prevented", "composing"] as const)(
    "%s Escape preserves the retained NotePanel selection until Cancel has focus",
    async (source) => {
      await page.goto(`${baseUrl}?notes`)
      const owner = page.locator("[data-retained-owner]")
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 })
      await owner.getByRole("button", { name: "Notes list options", exact: true }).press("Enter")
      await page.waitForFunction(() => document.querySelector('[role="menu"]')?.contains(document.activeElement))
      await page.keyboard.press("End")
      await page.keyboard.press("ArrowUp")
      expect(
        await page
          .getByRole("menuitem", { name: "Select notes", exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true)
      await page.keyboard.press("Enter")
      await page.getByRole("menu").waitFor({ state: "hidden" })
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Notes list options")
      await owner.locator(".note-resource-row").press("Space")
      expect(await owner.locator(".note-resource-row").getAttribute("aria-pressed")).toBe("true")
      const original = await owner.locator(".note-list-search input").elementHandle()
      const selected = await owner.locator(".note-resource-row").elementHandle()
      await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(false))
      await page.getByRole("textbox", { name: "Other editor" }).focus()
      await page.keyboard.press("Escape")
      expect(await owner.locator(".note-resource-row").getAttribute("aria-pressed")).toBe("true")

      await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(true))
      expect(
        await owner.locator(".note-list-search input").evaluate((element, previous) => element === previous, original),
      ).toBe(true)
      expect(
        await owner.locator(".note-resource-row").evaluate((element, previous) => element === previous, selected),
      ).toBe(true)
      const input =
        source === "external editor"
          ? page.getByRole("textbox", { name: "Other editor" })
          : owner.locator(".note-list-search input")
      await input.focus()
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true)
      if (source === "prevented") {
        await input.evaluate((element) =>
          element.addEventListener("keydown", (event) => event.preventDefault(), { once: true }),
        )
      }
      if (source === "composing") {
        await input.dispatchEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true })
      } else {
        await page.keyboard.press("Escape")
      }
      expect(await owner.locator(".note-resource-row").getAttribute("aria-pressed")).toBe("true")

      await owner.getByRole("button", { name: "Cancel", exact: true }).focus()
      await page.keyboard.press("Escape")
      expect(await owner.locator(".note-resource-row").getAttribute("aria-pressed")).toBeNull()
      expect(await owner.getByRole("button", { name: "Cancel", exact: true }).count()).toBe(0)
    },
  )

  test("a retained Notes navigator ignores hidden measurements and fits the restored viewport", async () => {
    await page.goto(`${baseUrl}?notes`)
    const owner = page.locator("[data-retained-owner]")
    const navigation = owner.locator("[data-workspace-navigation]")
    await navigation.waitFor({ state: "visible" })
    const original = await owner.locator(".note-list-search input").elementHandle()
    const width = await navigation.evaluate((element) => element.getBoundingClientRect().width)
    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(false))
    await page.setViewportSize({ width: 360, height: 600 })
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    expect(await navigation.evaluate((element) => parseFloat((element as HTMLElement).style.width))).toBe(width)
    await page.evaluate(() => (window as unknown as RetainedInputWindow).fixture.setActive(true))
    await page.waitForFunction(() => {
      const owner = document.querySelector<HTMLElement>("[data-retained-owner]")!
      const navigation = owner.querySelector<HTMLElement>("[data-workspace-navigation]")!
      return Math.abs(navigation.getBoundingClientRect().width - owner.getBoundingClientRect().width) < 1
    })
    expect(
      await owner.locator(".note-list-search input").evaluate((element, previous) => element === previous, original),
    ).toBe(true)
    expect(pageErrors).toEqual([])
  })
})

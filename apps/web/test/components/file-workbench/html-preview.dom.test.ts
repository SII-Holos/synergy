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
        import { createStore } from "solid-js/store"
        const [drafts, setDrafts] = createStore({})
        const [documents, setDocuments] = createStore({})
        const [modes, setModes] = createStore({})
        const content = path => documents[path] ?? "<p>source</p>"
        const pending = []
        let held = false
        export const saves = [], modeChanges = []
        export const holdSaves = value => { held = value }
        export const finishSaves = () => { for (const finish of pending.splice(0)) finish() }
        export const FileWorkspaceProvider = (props) => props.children
        export const useProjectFiles = () => ({ roots: () => [], search: async () => [], open: async () => {} })
        export const useFile = () => ({
          draft: {
            backupUnavailable: () => false,
            get: path => drafts[path],
            dirty: path => !!drafts[path] && drafts[path].content !== drafts[path].baseContent,
            begin: path => setDrafts(path, { baseContent: content(path), content: content(path), expectedVersion: "version-1" }),
            update: (path, value) => setDrafts(path, "content", value),
            discard: path => setDrafts(path, undefined),
          },
          workspace: { id: "wsp_demo", generation: 1, scopeID: "home", path: "/workspace/demo", type: "directory" },
          reference: () => ({ workspaceID: "wsp_demo", workspaceGeneration: 1 }),
          resourceKey: "demo",
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
            selectedLines: () => undefined,
            imageScaleMode: () => "fit",
            setImageScaleMode: () => {},
          },
          pdf: { get: () => undefined, load: async () => {} },
          explorer: { open: () => false, width: () => 260, setWidth() {}, setOpen: () => {}, reveal: async () => {} },
        })
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
        import { FileWorkbenchContent } from ${JSON.stringify(`/@fs/${componentPath}`)}
        const NotePanel = lazy(() => import(${JSON.stringify(`/@fs/${appSrc}/components/note/panel.tsx`)}).then(module => ({ default: module.NotePanel })))
        import { ViewActivityProvider } from "@/context/view-residency"
        import { saves, modeChanges, holdSaves, finishSaves } from "./file-stub"

        const i18n = setupI18n({ locale: "en" })
        const query = new URLSearchParams(location.search)
        const file = query.get("path") ?? ""
        const [active, setActive] = createSignal(true)
        const keys = []
        window.addEventListener("keydown", event => keys.push({ key: event.key, prevented: event.defaultPrevented }))
        window.fixture = { setActive, saves, modes: modeChanges, holdSaves, finishSaves, keys }
        const tab = path => ({ id: path, panelId: "file", title: path, resourceId: "wsp_demo@1/" + path,
          state: { workspace: { id: "wsp_demo", generation: 1, scopeID: "home", path: "/workspace/demo", type: "directory" } } })
        render(() => <I18nProvider i18n={i18n}><DialogProvider>
          <style>{"[data-retained-owner] { height: 240px } [data-retained-owner][hidden] { display: none }"}</style>
          <input aria-label="Other editor" />
          <ViewActivityProvider active={active}>
            <section data-retained-owner hidden={!active()} inert={!active()}>
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
      await owner.getByRole("button", { name: "Notes list options", exact: true }).press("Enter")
      await page.getByRole("menuitem", { name: "Select notes", exact: true }).press("Enter")
      await page.getByRole("menu").waitFor({ state: "hidden" })
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

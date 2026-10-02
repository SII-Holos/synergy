import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let url: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".browser-interaction-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "platform.ts"),
    `
    window.attachments = []; window.detachments = []; window.commands = []; window.dataActions = [];
    export const usePlatform = () => ({browserNative: {
      attachView: async input => window.attachments.push(input), resizeView: async () => {},
      dataAction: async ({action}) => {
        window.dataActions.push(action);
        if (action.type === "state") return window.dataState ?? {type:"state",passwordStorage:true,passwords:[],history:[]};
        if (action.type === "importSources") return {type:"sources",sources:[{id:"chrome-work",browser:"chrome",profile:"Work",mode:"direct",kinds:["passwords","cookies"]},{id:"safari",browser:"safari",mode:"file",kinds:["passwords"]},{id:"file",browser:"file",mode:"file",kinds:["passwords","cookies"]}]};
        if (action.type === "import") return window.importResult ?? {type:"import", imported:2,skipped:1,failed:0,cancelled:false,issues:[],items:action.kinds.map(kind=>({kind,imported:1,skipped:0,failed:0}))};
        return {type:"done"};
      },
      detachView: async input => window.detachments.push(input), focusView: async () => {}, onEvent: () => () => {}
    }})
  `,
  )
  await Bun.write(
    path.join(directory, "sdk.ts"),
    `export const useSDK = () => ({ scopeID: "home", client: { browser: { profiles: async () => ({data: { defaultProfileId: "personal", profiles: [{id: "personal", name: "Personal", enabled: true, kind: "persistent", origins: {}}] }}) } } })`,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal, Show } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
    import { BrowserImportDialog } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-import-dialog.tsx`)}
    import { BrowserDataDialog } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-data-settings.tsx`)}
    import { BrowserResultDialog } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-result-dialog.tsx`)}
    import { BrowserPageDialog } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/page-dialog.tsx`)}
    import { NativeBrowserSurface } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/native-browser-surface.tsx`)}
    import { BrowserSettings } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-settings.tsx`)}
    import { AddressBar } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/address-bar.tsx`)}
    import { BrowserStoreProvider, createBrowserStore } from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-store.tsx`)}
    import { messages } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const i18n = setupI18n({locale:"en",messages:{en:messages}})
    const store = createBrowserStore()
    store.replacePages([{id:"page-one",profileId:"personal",status:"active",url:"about:blank",title:"Test",isLoading:false,lastActiveAt:null}])
    store.setHostStatus("page-one", "ready")
    store.setPresentation({kind:"native",protocolVersion:4,capabilities:{native:true},reason:"desktop-local"})
    store._setSend(command => window.commands.push(command))
    window.browserFixture = store
    window.pageStateReplies = []
    function App() {
      let container
      const dialog = useDialog()
      const [request,setRequest] = createSignal()
      window.showPageDialog = (type, defaultValue = "Default draft") => setRequest({type,defaultValue,pageId:"page-one",requestId:"request-one",message:"Name this draft"})
      return <div class="synergy-workbench-canvas">
        <button onClick={() => window.showPageDialog("prompt")}>Open prompt</button>
        <button onClick={() => dialog.show(() => <BrowserImportDialog ownerKey="owner-one" pageId="page-one" />)}>Open import</button>
        <button onClick={() => dialog.show(() => <BrowserDataDialog ownerKey="owner-one" pageId="page-one" url="https://example.test/login" section="passwords" />)}>Open passwords</button>
        <button onClick={() => dialog.show(() => <BrowserResultDialog initial={{type:"capture", dataUrl:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4xkAAAAASUVORK5CYII=",width:100,height:100,url:"https://example.test/page",title:"Capture",capturedAt:1}} recapture={async () => {throw new Error("Unused")}} attach={async (file,text) => {window.captureResult = {name:file.name,type:file.type,text}}} />)}>Open screenshot</button>
        <div class="browser-workspace" style="height:500px">
          <AddressBar onPageAction={async action => {window.commands.push(action);if(action.type === "state" && window.holdPageState) return await new Promise(resolve => window.pageStateReplies.push(resolve));return {type:"state",back:false,forward:false,zoom:1}}} activeUrl={() => store.page()?.url ?? ""} isLoading={() => false} hasPage={() => true} onNavigate={() => {}} onHistory={() => {}} onReload={() => {}} onStop={() => {}} onRequestDiagnostics={() => {}} onSettings={() => dialog.show(() => <BrowserSettings sessionID="session-one" createTicket={async () => "ticket"} />)} />
          <div ref={container} style="position:relative;height:400px"><NativeBrowserSurface container={() => container} ownerKey="owner-one" /></div>
        </div>
        <Show when={request()} keyed>{request => <BrowserPageDialog request={request} onRespond={(accept,promptText) => {window.commands.push({accept,promptText});setRequest(undefined)}} />}</Show>
      </div>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><BrowserStoreProvider store={store}><App /></BrowserStoreProvider></DialogProvider></I18nProvider>, document.querySelector("#root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: {
        "@/context/sdk": path.join(directory, "sdk.ts"),
        "@/context/platform": path.join(directory, "platform.ts"),
        "@": source,
      },
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "zod"] },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 900, height: 800 } })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(url)
  await page.getByRole("button", { name: "Browser options", exact: true }).waitFor()
}, 60000)

beforeEach(async () => {
  await page.close()
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

type Fixture = Window & {
  holdPageState?: boolean
  pageStateReplies: Array<(state: { type: "state"; back: boolean; forward: boolean; zoom: number }) => void>
  captureResult?: { name: string; type: string; text: string }
  commands: Array<{ accept?: boolean; promptText?: string }>
  attachments: Array<{ pageId: string; visible: boolean }>
  detachments: unknown[]
  showPageDialog(type: string, value?: string): void
  browserFixture: {
    replacePages(pages: unknown[]): void
    setHostStatus(id: string, status: string): void
    setBrowserError(error: unknown): void
    setAnnotationTarget(target: unknown): void
  }
}

test("address controls retain the current navigation when an older state reply arrives last", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Browser options", exact: true }).waitFor()
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.holdPageState = true
    fixture.browserFixture.replacePages([
      { id: "page-one", profileId: "personal", status: "active", url: "https://example.test/first", title: "First" },
    ])
  })
  await page.waitForFunction(() => (window as unknown as Fixture).pageStateReplies.length === 1)
  await page.evaluate(() => {
    ;(window as unknown as Fixture).browserFixture.replacePages([
      { id: "page-one", profileId: "personal", status: "active", url: "https://example.test/second", title: "Second" },
    ])
  })
  await page.waitForFunction(() => (window as unknown as Fixture).pageStateReplies.length === 2)
  await page.evaluate(() => {
    ;(window as unknown as Fixture).pageStateReplies[1]!({ type: "state", back: true, forward: true, zoom: 1.5 })
  })
  const back = page.getByRole("button", { name: "Back", exact: true })
  const forward = page.getByRole("button", { name: "Forward", exact: true })
  await back.waitFor()
  expect(await back.isEnabled()).toBe(true)
  await page.evaluate(async () => {
    ;(window as unknown as Fixture).pageStateReplies[0]!({ type: "state", back: false, forward: false, zoom: 1 })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  expect(await back.isEnabled()).toBe(true)
  expect(await forward.isEnabled()).toBe(true)
  await page.getByRole("button", { name: "Browser options", exact: true }).click()
  expect(await page.getByRole("button", { name: "Reset zoom", exact: true }).innerText()).toBe("150%")
})

test("prompt selects the default, submits edited and empty values, cancels separately, and restores focus", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open prompt" }).click()
  const input = page.getByRole("textbox", { name: "Response", exact: true })
  await input.waitFor()
  expect(
    await input.evaluate((node) => {
      const input = node as HTMLInputElement
      return [input.value, input.selectionStart, input.selectionEnd, document.activeElement === node]
    }),
  ).toEqual(["Default draft", 0, 13, true])
  await input.fill("New draft")
  await input.press("Enter")
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1))).toEqual({
    accept: true,
    promptText: "New draft",
  })
  await page.waitForFunction(
    () => document.activeElement?.tagName === "BUTTON" && document.activeElement.textContent === "Open prompt",
  )
  expect(
    await page.getByRole("button", { name: "Open prompt" }).evaluate((node) => document.activeElement === node),
  ).toBe(true)
  await page.getByRole("button", { name: "Open prompt" }).click()
  await input.fill("")
  await input.press("Enter")
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1))).toEqual({
    accept: true,
    promptText: "",
  })
  await page.getByRole("button", { name: "Open prompt" }).click()
  await input.press("Escape")
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1))).toEqual({
    accept: false,
    promptText: undefined,
  })
  expect(errors).toEqual([])
})

test("alert has only acknowledgement and confirm retains cancellation at 375px", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(url)
  await page.evaluate(() => (window as unknown as Fixture).showPageDialog("alert"))
  await page.getByRole("dialog").waitFor()
  expect(await page.getByRole("button", { name: "Cancel", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "OK", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1)?.accept)).toBe(true)
  await page.evaluate(() => (window as unknown as Fixture).showPageDialog("confirm"))
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as Fixture).commands.at(-1)?.accept)).toBe(false)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test("shared Browser menu returns focus on Escape and native view resumes only after the final blocker", async () => {
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(url)
  const menu = page.getByRole("button", { name: "Browser options", exact: true })
  await menu.click()
  await page.getByText("Developer tools", { exact: true }).click()
  await page.getByRole("switch").waitFor()
  expect(await page.evaluate(() => (window as unknown as Fixture).attachments.at(-1)?.visible)).toBe(false)
  await page.evaluate(() =>
    (window as unknown as Fixture).browserFixture.setBrowserError({ severity: "error", message: "Test error" }),
  )
  await page.getByRole("switch").press("Escape")
  await page.getByRole("switch").waitFor({ state: "hidden" })
  expect(await menu.evaluate((node) => document.activeElement === node)).toBe(true)
  expect(await page.evaluate(() => (window as unknown as Fixture).attachments.at(-1)?.visible)).toBe(false)
  await page.evaluate(() => (window as unknown as Fixture).browserFixture.setBrowserError(null))
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible === true)
  await page.evaluate(() =>
    (window as unknown as Fixture).browserFixture.setAnnotationTarget({ displayX: 20, displayY: 20 }),
  )
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible === false)
  await page.evaluate(() => (window as unknown as Fixture).browserFixture.setAnnotationTarget(null))
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible === true)
  expect(await page.evaluate(() => (window as unknown as Fixture).detachments.length)).toBe(0)
  expect(
    await page.evaluate(() => [...new Set((window as unknown as Fixture).attachments.map((x) => x.pageId))]),
  ).toEqual(["page-one"])
  expect(errors).toEqual([])
})

test("page content never introduces a nested tab strip or profile management", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Browser options", exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Identities", exact: true }).count()).toBe(0)
  expect(await page.getByRole("tablist").count()).toBe(0)
})

test("browser settings returns focus to its durable menu trigger and preserves the native page", async () => {
  await page.goto(url)
  const menu = page.getByRole("button", { name: "Browser options", exact: true })
  await menu.click()
  await page.getByRole("button", { name: "Browser settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Browser settings", exact: true })
  await settings.getByText("Separate accounts and advanced settings", { exact: true }).click()
  await settings.getByRole("button", { name: "Add browser profile", exact: true }).waitFor()
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible === false)
  await settings.press("Escape")
  await settings.waitFor({ state: "hidden" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("title") === "Browser options", undefined, {
    timeout: 2000,
  })
  expect(await menu.evaluate((node) => document.activeElement === node)).toBe(true)
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible === true)
  expect(await page.evaluate(() => (window as unknown as Fixture).detachments)).toEqual([])
})

test("screenshot keyboard mark remains in image bounds and keeps feedback with its attachment", async () => {
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(url)
  await page.getByRole("button", { name: "Open screenshot", exact: true }).click()
  const mark = page.getByRole("button", { name: "Marked location", exact: true })
  await mark.focus()
  await mark.press("Enter")
  await page
    .getByRole("textbox", { name: "Describe what you want to change or check…", exact: true })
    .fill("Keep this feedback")
  await page.getByRole("button", { name: "Add to draft", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  const result = await page.evaluate(() => (window as unknown as Fixture).captureResult)
  expect(result?.type).toBe("image/png")
  expect(result?.text).toContain("(50, 50) of 100 × 100")
  expect(result?.text).toContain("Feedback: Keep this feedback")
  expect(result?.text).toContain("https://example.test/page")
})

test("saved accounts filter by website and only the current origin can fill a login", async () => {
  await page.goto(url)
  await page.evaluate(() => {
    Object.assign(window, {
      dataState: {
        type: "state",
        passwordStorage: true,
        history: [],
        passwords: [
          { id: "current", origin: "https://example.test", username: "alice" },
          { id: "other", origin: "https://other.test", username: "bob" },
        ],
      },
    })
  })
  await page.getByRole("button", { name: "Open passwords", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Passwords and autofill", exact: true })
  const filter = dialog.getByRole("searchbox", { name: "Search websites or usernames" })
  await dialog.getByText("alice", { exact: true }).waitFor()
  expect(await dialog.getByRole("button", { name: "Fill login", exact: true }).count()).toBe(1)
  await filter.fill("bob")
  await dialog.getByText("alice", { exact: true }).waitFor({ state: "hidden" })
  expect(await dialog.getByText("bob", { exact: true }).isVisible()).toBe(true)
  expect(await dialog.getByRole("button", { name: "Fill login", exact: true }).count()).toBe(0)
  await filter.fill("alice")
  await dialog.getByRole("button", { name: "Fill login", exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
  expect(await page.evaluate(() => Reflect.get(window, "dataActions"))).toEqual([
    { type: "state" },
    { type: "fillLogin", id: "current" },
  ])
})

test("a suspended page does not probe unavailable native navigation controls", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Browser options", exact: true }).waitFor()
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.commands.length = 0
    fixture.browserFixture.setHostStatus("page-one", "detached")
    fixture.browserFixture.replacePages([
      {
        id: "page-one",
        profileId: "personal",
        status: "suspended",
        url: "https://example.test/restored",
        title: "Restored",
        isLoading: false,
        lastActiveAt: null,
      },
    ])
  })
  await page.getByRole("button", { name: "Browser options", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as Fixture).commands)).toEqual([])
})

test("import chooses a browser and independent data types without exposing implementation controls", async () => {
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(url)
  await page.getByRole("button", { name: "Open import", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Import browser data", exact: true })
  await dialog.getByRole("button", { name: "From: Google Chrome · Work", exact: true }).waitFor()
  expect(await dialog.getByRole("heading", { name: "Import browser data", exact: true }).count()).toBe(1)
  await dialog.getByRole("switch", { name: "Passwords", exact: true }).focus()
  await dialog.getByRole("switch", { name: "Passwords", exact: true }).press("Space")
  await dialog.getByRole("button", { name: "Import", exact: true }).click()
  await dialog.getByRole("button", { name: "Done", exact: true }).waitFor()
  expect(
    await page.evaluate(() =>
      (window as unknown as { dataActions: unknown[] }).dataActions.find(
        (a: unknown) => (a as { type: string }).type === "import",
      ),
    ),
  ).toMatchObject({ sourceId: "chrome-work", kinds: ["cookies"], overwrite: false })
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await page.getByRole("button", { name: "Open import", exact: true }).waitFor()
})

test("Safari shows an honest export path and import dialog stays within a narrow viewport", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(url)
  await page.getByRole("button", { name: "Open import", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Import browser data", exact: true })
  await dialog.getByRole("button", { name: "From: Google Chrome · Work", exact: true }).click()
  await page.getByRole("option", { name: "Safari", exact: true }).click()
  await page.getByRole("listbox", { name: "From", exact: true }).waitFor({ state: "detached" })
  expect(await dialog.getByRole("switch", { name: "Cookies", exact: true }).isDisabled()).toBe(true)
  await dialog
    .getByText(
      "In Safari, choose File → Export Browsing Data, include passwords, then select the exported ZIP or CSV here.",
      { exact: true },
    )
    .waitFor()
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
  await dialog.press("Escape")
  await dialog.waitFor({ state: "detached" })
})

test("partial import keeps successful counts visible alongside the recovery reason", async () => {
  await page.goto(url)
  await page.evaluate(() => {
    Object.assign(window, {
      importResult: {
        type: "import",
        imported: 3,
        skipped: 0,
        failed: 0,
        cancelled: false,
        issues: [],
        items: [{ kind: "passwords", imported: 3, skipped: 0, failed: 0, error: "unavailable" }],
      },
    })
  })
  await page.getByRole("button", { name: "Open import", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Import browser data", exact: true })
  await dialog.getByRole("button", { name: "Import", exact: true }).click()
  expect(await dialog.getByRole("status").textContent()).toContain("3 imported · 0 skipped · 0 failed")
  expect(await dialog.getByRole("status").textContent()).toContain("This data could not be read.")
})

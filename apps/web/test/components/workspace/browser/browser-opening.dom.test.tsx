import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"
import type { WorkbenchPanelTab } from "../../../../src/plugin/registries/workbench-panel-registry"

let directory: string
let browser: Browser
let context: BrowserContext
let page: Page
let server: ViteDevServer
let url: string
const source = path.resolve(import.meta.dir, "../../../../src")
const errors: string[] = []

interface Fixture extends Window {
  fixture: {
    finish(): void
    fail(structured?: boolean): void
    open(forceNew?: boolean): Promise<void>
    close(id: string): Promise<void>
    dataRequests: Array<{ pageId: string; action: { type: string } }>
    collapse(): void
    session(): void
    scope(): void
    tabs(): WorkbenchPanelTab[]
    saved(): WorkbenchPanelTab[]
    active(): string | undefined
    publish(pages: Array<{ id: string; title: string; url: string }>): void
    opened(): boolean
    attempts: string[]
    cancelled: string[]
  }
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".browser-opening-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root" class="synergy-workbench-canvas"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import { createSignal } from "solid-js"
    import { setupI18n } from "@lingui/core"
    import { messages } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    export const i18n=setupI18n({locale:"en",messages:{en:messages}})
    export const useLocale=() => ({i18n})
    export const useConfirm=() => ({ask:async () => true})
    const surfaces=new Map()
    export function surface(key,name) {
      const id=key+":"+name
      if(surfaces.has(id)) return surfaces.get(id)
      const [tabs,setTabs]=createSignal([]), [active,setActive]=createSignal(), [opened,setOpened]=createSignal(false)
      const [size,setSize]=createSignal(400), [fullscreen,setFullscreen]=createSignal(false), [reveal,setReveal]=createSignal({})
      const value={tabs,setTabs,active,setActive,activeTab:() => tabs().find(tab => tab.id===active()),opened,open:() => setOpened(true),close:() => setOpened(false),toggle:() => setOpened(!opened()),size,setSize,fullscreen,setFullscreen,reveal,setReveal}
      surfaces.set(id,value); return value
    }
    export const useLayout=() => ({surface,transferWorkbenchState() {},isDesktop:() => true,sidebar:{opened:() => false,width:() => 260,occupiedWidth:() => 0}})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {I18nProvider} from "@lingui/solid"
    import {MemoryRouter,Route,createMemoryHistory,useNavigate} from "@solidjs/router"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {WorkbenchPanelsProvider,useWorkbenchPanels} from ${JSON.stringify(`/@fs/${source}/context/workbench/index.tsx`)}
    import {WorkbenchSurface} from ${JSON.stringify(`/@fs/${source}/components/workspace/workbench-surface.tsx`)}
    import {BrowserPreparingPanel} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-preparing.tsx`)}
    import {BrowserCatalogProvider} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-catalog.tsx`)}
    import {BrowserWorkbenchSync} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-workbench-sync.tsx`)}
    import {registerWorkbenchPanel} from ${JSON.stringify(`/@fs/${source}/plugin/registries/workbench-panel-registry.ts`)}
    import {i18n,surface} from "./services"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    window.pages=[];window.dataRequests=[]
    const attempts=[],cancelled=[],pending=[]
    const create=(_init,operation) => new Promise((resolve,reject) => {
      attempts.push(operation?.requestId ?? "unbound")
      pending.push({resolve,reject,operation,index:attempts.length})
    })
    registerWorkbenchPanel({id:"resource-home",label:"New tab",icon:"file",surface:"side",cardinality:"multi",launchable:false,component:() => <div>Resources</div>})
    registerWorkbenchPanel({id:"browser",label:"Browser",icon:"globe",surface:"side",cardinality:"multi",title:tab => tab.title ?? "Browser",createTab:create,restoreTab:operation => create(undefined,operation),openingComponent:props => <BrowserPreparingPanel tab={props.tab} />,loader:async () => ({default:() => <div><input aria-label="Ready browser" /></div>})})
    function Harness() {
      const workbench=useWorkbenchPanels(),navigate=useNavigate()
      window.fixture={attempts,cancelled,dataRequests:window.dataRequests,
        finish:() => {const item=pending.shift();const init={resourceId:item.index===1 ? "page-one" : "page-"+item.index,title:"Ready browser"};window.pages.push({id:init.resourceId,title:init.title,url:"about:blank",status:"active",profileId:"personal"});item.operation?.onCancel(() => {cancelled.push(init.resourceId)});item.resolve(init)},
        fail:structured => pending.shift().reject(structured ? {code:"browser_native_ticket_rejected",message:"Desktop ticket unavailable",retryable:true} : new Error("Browser unavailable")),
        open:forceNew => workbench.openPanel("browser",{forceNew}),close:id => workbench.closeTab(id),collapse:() => workbench.surface("side").close(),session:() => navigate("/home/session/other"),scope:() => navigate("/other"),
        publish:pages => {window.pages=pages.map(page => ({status:"active",profileId:"personal",...page}));window.deliverPages(window.pages)},tabs:() => workbench.surface("side").tabs(),saved:() => surface(workbench.sessionKey(),"side").tabs(),active:() => workbench.surface("side").active(),opened:() => workbench.surface("side").opened()
      }
      return <div style="height:600px"><button onClick={() => workbench.surface("side").toggle()}>Workspace</button><button onClick={() => workbench.openPanel("resource-home")}>Other resource</button><WorkbenchSurface surface="side" />{location.search==="?sync" && <BrowserWorkbenchSync route={{mode:"scope",scopeID:"home",path_directory:"home"}} />}</div>
    }
    const history=createMemoryHistory();history.set({value:"/home/session/one"})
    render(() => <I18nProvider i18n={i18n}><DialogProvider><MemoryRouter history={history}><Route path="/:dir/session/:id" component={() => <WorkbenchPanelsProvider><BrowserCatalogProvider><Harness /></BrowserCatalogProvider></WorkbenchPanelsProvider>} /><Route path="/other" component={() => <div>Other Scope</div>} /></MemoryRouter></DialogProvider></I18nProvider>,document.querySelector("#root"))
  `,
  )
  await Bun.write(
    path.join(directory, "sdk.ts"),
    `export const useSDK=() => ({url:"http://fixture.test",scopeID:"home",client:{browser:{session:async () => ({data:{ownerKey:"scope:home:scope",pages:window.pages,seq:window.pages.length,epoch:"one",hostStatus:"ready",presentation:{kind:"native",protocolVersion:5,capabilities:{native:true},reason:"desktop-local"}}})}}})`,
  )
  await Bun.write(
    path.join(directory, "platform.ts"),
    `export const usePlatform=() => ({browserNative:{dataAction:async input => {window.dataRequests.push(input);return input.action.type==="importSources" ? {type:"sources",sources:[{id:"file",browser:"file",mode:"file",kinds:["passwords","cookies"]}]} : {type:"state",passwordStorage:true,passwords:[],history:[]}}}})`,
  )
  await Bun.write(
    path.join(directory, "transport.ts"),
    `export const createBrowserWebSocket=store => {store._setSend(() => {});window.deliverPages=pages => store.replacePages(pages); return {}}`,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        { find: /^@\/context\/(layout|locale)$/, replacement: path.join(directory, "services.ts") },
        { find: "../layout", replacement: path.join(directory, "services.ts") },
        { find: "@/context/sdk", replacement: path.join(directory, "sdk.ts") },
        { find: "@/context/platform", replacement: path.join(directory, "platform.ts") },
        { find: "./browser-ws", replacement: path.join(directory, "transport.ts") },
        { find: "@/components/dialog/confirm-dialog", replacement: path.join(directory, "services.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 60_000)

beforeEach(async () => {
  errors.length = 0
  context = await browser.newContext({ viewport: { width: 1200, height: 700 } })
  page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(5_000)
  await page.goto(url, { timeout: 30_000 })
  await page.getByRole("button", { name: "Workspace", exact: true }).waitFor()
})
afterEach(async () => {
  await context?.close()
})
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("Workspace shows an unpersisted Browser tab and frame before asynchronous creation settles", async () => {
  const first = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("button")!.click()
    return new Promise<{ tabs: number; frame: boolean }>((resolve) =>
      requestAnimationFrame(() =>
        resolve({
          tabs: document.querySelectorAll('[role="tab"]').length,
          frame: Boolean(document.querySelector(".browser-new-tab-footer")),
        }),
      ),
    )
  })
  expect(first).toEqual({ tabs: 1, frame: true })
  await page.getByRole("tab", { name: "Browser", exact: true }).waitFor()
  await page.getByRole("button", { name: "Import browser data", exact: true }).waitFor()
  const before = await page.evaluate(() => ({
    tabs: (window as unknown as Fixture).fixture.tabs(),
    saved: (window as unknown as Fixture).fixture.saved(),
  }))
  expect(before.tabs).toHaveLength(1)
  expect(before.saved).toEqual([])
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  await page.getByRole("textbox", { name: "Ready browser", exact: true }).waitFor()
  const after = await page.evaluate(() => (window as unknown as Fixture).fixture.tabs())
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: before.tabs[0]!.id, resourceId: "page-one" })
  expect(errors).toEqual([])
})

test("catalog events before the open response cannot duplicate the preparing tab or steal selection", async () => {
  await page.goto(`${url}?sync`, { timeout: 30_000 })
  await page.waitForFunction(() => typeof (window as unknown as { deliverPages?: unknown }).deliverPages === "function")
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("tab", { name: "Browser", exact: true }).waitFor()
  const id = await page.evaluate(() => (window as unknown as Fixture).fixture.active())
  await page.evaluate(() =>
    (window as unknown as Fixture).fixture.publish([
      { id: "page-one", title: "Created", url: "about:blank" },
      { id: "popup", title: "Popup", url: "https://example.test" },
    ]),
  )
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.tabs())).toHaveLength(1)
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.opened())).toBe(true)
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.saved().length === 2)
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.tabs().map((tab) => tab.resourceId))).toEqual(
    ["page-one", "popup"],
  )
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.active())).toBe(id)
  expect(errors).toEqual([])
})

test("import opens immediately, shares preparation, and survives replacement of its source frame", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("button", { name: "Import browser data", exact: true }).click()
  await page.getByRole("dialog", { name: "Import browser data", exact: true }).waitFor()
  expect(await page.getByRole("status").last().innerText()).toBe("Preparing browser…")
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.dataRequests)).toEqual([])
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  await page.getByRole("button", { name: "Choose file and import", exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.attempts)).toHaveLength(1)
  expect(
    await page.evaluate(() => (window as unknown as Fixture).fixture.dataRequests.map((input) => input.pageId)),
  ).toEqual(["page-one", "page-one"])
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("textbox", { name: "Ready browser", exact: true }).waitFor()
  expect(errors).toEqual([])
})

test("a failed opening retains its single tab when catalog events arrive before retry", async () => {
  await page.goto(`${url}?sync`, { timeout: 30_000 })
  await page.waitForFunction(() => typeof (window as unknown as { deliverPages?: unknown }).deliverPages === "function")
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("tab", { name: "Browser", exact: true }).waitFor()
  const id = await page.evaluate(() => (window as unknown as Fixture).fixture.active())
  await page.evaluate(() => (window as unknown as Fixture).fixture.fail())
  await page.getByRole("alert").waitFor()
  await page.evaluate(() =>
    (window as unknown as Fixture).fixture.publish([{ id: "popup", title: "Popup", url: "https://example.test" }]),
  )
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.tabs())).toHaveLength(1)
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.attempts.length === 2)
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.saved().length === 2)
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.active())).toBe(id)
  expect(errors).toEqual([])
})

test("closing the original import page invalidates discovery without targeting another page", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("button", { name: "Import browser data", exact: true }).click()
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  await page.getByRole("button", { name: "Choose file and import", exact: true }).waitFor()
  await page.evaluate(() =>
    (window as unknown as Fixture).fixture.publish([{ id: "other", title: "Other", url: "about:blank" }]),
  )
  await page.getByRole("alert").filter({ hasText: "The browser target changed or closed" }).waitFor()
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: "The browser target changed or closed" }).waitFor()
  expect(
    await page.evaluate(() => (window as unknown as Fixture).fixture.dataRequests.map((input) => input.pageId)),
  ).toEqual(["page-one", "page-one"])
  expect(errors).toEqual([])
})

test("collapse and reopen share the pending page and a late result cannot reopen a collapsed Workspace", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("tab", { name: "Browser", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).fixture.collapse())
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.attempts)).toHaveLength(1)
  await page.evaluate(() => {
    const fixture = (window as unknown as Fixture).fixture
    fixture.collapse()
    fixture.finish()
  })
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.saved().length === 1)
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.opened())).toBe(false)
  expect(errors).toEqual([])
})

test("closing a pending tab discards its late page while changing Session only abandons presentation", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("button", { name: "Close Browser", exact: true }).click()
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.cancelled.length === 1)
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.tabs())).toEqual([])
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("tab", { name: "Browser", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).fixture.session())
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.tabs())).toEqual([])
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.cancelled)).toEqual(["page-one"])
  expect(errors).toEqual([])
})

test("failed preparation retries the same opening intent and explicit new actions keep separate pages", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("tab", { name: "Browser", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).fixture.fail())
  await page.getByRole("alert").waitFor()
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.attempts.length === 2)
  const attempts = await page.evaluate(() => (window as unknown as Fixture).fixture.attempts)
  expect(attempts[0]).toBe(attempts[1])
  await page.evaluate(() => {
    void (window as unknown as Fixture).fixture.open(true)
  })
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.attempts.length === 3)
  await page.evaluate(() => {
    const fixture = (window as unknown as Fixture).fixture
    fixture.finish()
    fixture.finish()
  })
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.saved().length === 2)
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.tabs().map((tab) => tab.resourceId))).toEqual(
    ["page-2", "page-3"],
  )
  expect(errors).toEqual([])
})

test("structured native failures retain a visible reason and an explicit Retry action", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("tab", { name: "Browser", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).fixture.fail(true))
  await page.getByRole("alert").filter({ hasText: "Desktop ticket unavailable" }).waitFor()
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.attempts.length === 2)
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  await page.getByRole("textbox", { name: "Ready browser", exact: true }).waitFor()
  expect(errors).toEqual([])
})

test("preparation has a bounded deadline and a late result cannot silently replace its error", async () => {
  await page.clock.install()
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.clock.runFor(15_001)
  await page.getByRole("alert").filter({ hasText: "Browser preparation timed out" }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.saved())).toEqual([])
  await page.getByRole("alert").filter({ hasText: "Browser preparation timed out" }).waitFor()
  await page.getByRole("button", { name: "Close Browser", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as Fixture).fixture.cancelled.length === 1)
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.opened())).toBe(false)
  expect(errors).toEqual([])
})

test("changing Scope invalidates a ready import dialog when its Workspace owner is disposed", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("button", { name: "Import browser data", exact: true }).click()
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  await page.getByRole("button", { name: "Choose file and import", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).fixture.scope())
  await page.getByRole("alert").filter({ hasText: "The browser target changed or closed" }).waitFor()
  expect(
    await page.evaluate(() => (window as unknown as Fixture).fixture.dataRequests.map((input) => input.action.type)),
  ).toEqual(["importSources", "state"])
  expect(errors).toEqual([])
})

test("changing Scope ends pending import preparation immediately and ignores its late result", async () => {
  await page.getByRole("button", { name: "Workspace", exact: true }).click()
  await page.getByRole("button", { name: "Import browser data", exact: true }).click()
  await page.getByRole("dialog", { name: "Import browser data", exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).fixture.scope())
  await page.getByRole("alert").filter({ hasText: "The browser target changed or closed" }).waitFor()
  await page.evaluate(() => (window as unknown as Fixture).fixture.finish())
  expect(await page.evaluate(() => (window as unknown as Fixture).fixture.dataRequests)).toEqual([])
  expect(errors).toEqual([])
})

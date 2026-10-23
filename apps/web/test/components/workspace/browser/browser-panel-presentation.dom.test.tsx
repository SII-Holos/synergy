import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"
import type { BrowserStoreAPI } from "../../../../src/components/workspace/browser/browser-store"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let url: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".browser-panel-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "sdk.ts"),
    `
    export const useSDK = () => ({url:"http://fixture.test",scopeID:"home",client:{browser:{
      session:async () => ({data:{ownerKey:"scope:home:scope",hostStatus:"ready",seq:window.seq,epoch:"epoch-one",pages:window.catalogPages,presentation:window.presentation}}),
      profiles:async () => ({data:{defaultProfileId:"personal",profiles:[{id:"personal",name:"Personal",enabled:true,kind:"persistent",revision:1}]}})
    }}})
  `,
  )
  await Bun.write(
    path.join(directory, "platform.ts"),
    `
    window.attachments=[]; window.detachments=[]; window.dataRequests=[]; window.resizes=[]; window.commands=[];
    export const usePlatform = () => ({browserNative:{
      presentationCapability:async () => ({protocolVersion:${BROWSER_PROTOCOL_VERSION},managedLocal:true,status:"ready"}),
      attachView:async input => window.attachments.push(input), resizeView:async input => window.resizes.push(input),
      detachView:async input => window.detachments.push(input), focusView:async () => {}, onEvent:() => () => {},
      get dataAction() { return window.dataUnavailable ? undefined : async input => {
        window.dataRequests.push(input);
        if(window.dataFailure) throw new Error("Native data unavailable");
        return input.action.type === "importSources" ? {type:"sources",sources:[{id:"file",browser:"file",mode:"file",kinds:["passwords","cookies"]}]} : {type:"state",passwordStorage:true,passwords:[],history:[]};
      }},
      pageAction:async () => ({type:"state",back:false,forward:false,zoom:1})
    }})
  `,
  )
  await Bun.write(
    path.join(directory, "transport.ts"),
    `
    export const createBrowserWebSocket = store => {
      window.deliverPresentation = value => store.setPresentation(value);
      window.store=store;
      store._setSend(message => {
        window.commands.push(message);
        if(message.type !== "page.open") return;
        return new Promise(resolve => { window.finishOpen = () => {
          const page={...window.pages[0],id:"page-copy",profileId:message.profileId,url:message.url};
          store.upsertPage(page); resolve(page);
        }});
      });
      return {createNativeTicket:async () => "ticket", retryNative:() => {}};
    }
  `,
  )
  await Bun.write(
    path.join(directory, "workbench.ts"),
    `
    import {useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    export const useWorkbenchPanels = () => ({sessionKey:() => "fixture",isCurrent:session => session==="fixture",showDialog:useDialog().show,openingForTab:() => undefined,surface:() => ({active:() => window.activeTabId}),openPanel:(_id,options) => window.openPanel(options)})
  `,
  )
  await Bun.write(path.join(directory, "draft.ts"), "export const useBrowserDraft = () => ({})")
  await Bun.write(path.join(directory, "router.ts"), 'export const useParams = () => ({ id: "current" })')
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createResource,createSignal,For,Show,Suspense} from "solid-js"
    import {createStore} from "solid-js/store"
    import {ViewActivityProvider} from ${JSON.stringify(`/@fs/${source}/context/view-residency.tsx`)}
    import {MetaProvider} from "@solidjs/meta"
    import {Font} from "@ericsanchezok/synergy-ui/font"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {BrowserCatalogProvider,useBrowserCatalog} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-catalog.tsx`)}
    import {BrowserPanel} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-panel.tsx`)}
    import {browserPageTab} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-workbench-model.ts`)}
    import {messages} from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import {messages as zh} from ${JSON.stringify(`/@fs/${source}/locales/zh-CN/messages.po`)}
    import {messages as pseudo} from ${JSON.stringify(`/@fs/${source}/locales/pseudo/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    window.presentation={kind:"native",protocolVersion:${BROWSER_PROTOCOL_VERSION},capabilities:{native:true},reason:"desktop-local"};
    window.pages=["one","two"].map(id => ({id:"page-"+id,profileId:"personal",status:"active",url:new URLSearchParams(location.search).has("blank") ? "about:blank" : "https://example.test/"+id,title:id,isLoading:false,lastActiveAt:null}));
    window.catalogPages=new URLSearchParams(location.search).has("missing") ? [] : window.pages;
    window.seq=1; window.dataUnavailable=new URLSearchParams(location.search).has("no-data");
    const route={mode:"scope",scopeID:"home",path_directory:"home"};
    const i18n=setupI18n({locale:"en",messages:{en:messages,"zh-CN":zh,pseudo}});
    window.setLocale=value => i18n.activate(value);
    function Harness() {
      const catalog=useBrowserCatalog();
      const [loaded]=createResource(() => catalog.get(route));
      const [active,setActive]=createSignal();
      const [tabs,setTabs]=createStore([]);
      window.openPanel=options => {
        const tab={panelId:"browser",...options.init};
        if(!tabs.some(item=>item.id===tab.id)) setTabs(tabs.length,tab);
        if(options.activate!==false) {window.activeTabId=tab.id; setActive(tab.id)};
      };
      const open=id => window.openPanel({init:browserPageTab(window.pages.find(p=>p.id===id),route)});
      window.presentPage=id => { const init=browserPageTab(window.pages.find(p=>p.id===id),route); window.openPanel({init:{...init,state:{...init.state,focusAddress:false}}}) };
      window.replaceMetadata=(id,title,url) => {
        const next={...window.pages.find(item=>item.id===id),title,url};
        window.store.upsertPage(next);
        setTabs(item=>item.resourceId===id,browserPageTab(next,route));
      };
      return <Suspense><Show when={loaded()} keyed>{state => <>
        {(() => {window.publishPage=() => {window.seq++; window.catalogPages=window.pages; state.store.upsertPage(window.pages[0])}; return null})()}
        <output aria-label="Presentation">{state.store.presentation()?.kind ?? "none"}</output>
        <textarea aria-label="Composer" />
        <button onClick={() => open("page-one")}>Open first</button>
        <button onClick={() => open("page-two")}>Open second</button>
        <div class="synergy-workbench-canvas" style="height:500px"><For each={tabs}>{tab => <ViewActivityProvider active={() => active()===tab.id}><section data-page={tab.resourceId} style={{height:"100%",display:active()===tab.id ? "block" : "none"}} inert={active()!==tab.id}><BrowserPanel tab={tab} /></section></ViewActivityProvider>}</For></div>
      </>}</Show></Suspense>
    }
    render(() => <MetaProvider><Font/><I18nProvider i18n={i18n}><DialogProvider><BrowserCatalogProvider><Harness /></BrowserCatalogProvider></DialogProvider></I18nProvider></MetaProvider>,document.querySelector("#root"));
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
        "@/context/workbench": path.join(directory, "workbench.ts"),
        "@solidjs/router": path.join(directory, "router.ts"),
        "@/context/session-route": path.join(directory, "router.ts"),
        "./browser-ws": path.join(directory, "transport.ts"),
        "./browser-draft": path.join(directory, "draft.ts"),
        "@": source,
      },
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "zod"] },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
}, 60_000)

beforeEach(async () => {
  errors.length = 0
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
})

afterEach(async () => {
  await page?.close()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

type Fixture = Window & {
  presentation: unknown
  setLocale(value: string): void
  deliverPresentation(value: unknown): void
  attachments: Array<{ pageId: string; visible: boolean }>
  publishPage(): void
  presentPage(id: string): void
  dataUnavailable: boolean
  dataFailure: boolean
  dataRequests: Array<{ pageId: string; action: { type: string } }>
  detachments: Array<{ pageId: string }>
  resizes: Array<{ pageId: string; bounds: { y: number; height: number } }>
  commands: Array<Parameters<BrowserStoreAPI["send"]>[0]>
  replaceMetadata(id: string, title: string, url: string): void
  store: BrowserStoreAPI
}

test("catalog metadata initializes presentation without waiting for an event or allocating a view", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).waitFor()
  expect(await page.getByLabel("Presentation").innerText()).toBe("native")
  expect(await page.evaluate(() => (window as unknown as Fixture).attachments)).toEqual([])
})

test("Agent presentation of a blank page preserves composer focus while explicit user opening keeps address autofocus", async () => {
  await page.goto(`${url}?blank`)
  const composer = page.getByRole("textbox", { name: "Composer", exact: true })
  await composer.fill("Retain this draft")
  await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 8, "backward"))
  await page.evaluate(() => (window as unknown as Fixture).presentPage("page-one"))
  await page.getByRole("combobox", { name: "Enter URL or search", exact: true }).waitFor()
  expect(
    await composer.evaluate((element: HTMLTextAreaElement) => [
      document.activeElement === element,
      element.value,
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
    ]),
  ).toEqual([true, "Retain this draft", 2, 8, "backward"])
  await page.getByRole("button", { name: "Open second", exact: true }).click()
  const address = page.getByRole("combobox", { name: "Enter URL or search", exact: true }).filter({ visible: true })
  expect(await address.evaluate((element) => document.activeElement === element)).toBe(true)
})

test("mounting and changing peer page panels preserves the catalog's current native presentation", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).waitFor()
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.deliverPresentation(fixture.presentation)
  })
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.getByRole("combobox", { name: "Enter URL or search", exact: true }).waitFor()
  expect(await page.getByLabel("Presentation").innerText()).toBe("native")
  await page.waitForFunction(() =>
    (window as unknown as Fixture).attachments.some((item) => item.pageId === "page-one" && item.visible),
  )
  await page.getByRole("button", { name: "Open second", exact: true }).click()
  await page.waitForFunction(() =>
    (window as unknown as Fixture).attachments.some((item) => item.pageId === "page-two" && item.visible),
  )
  expect(await page.getByLabel("Presentation").innerText()).toBe("native")
  expect(await page.getByRole("combobox").inputValue()).toBe("https://example.test/two")
  expect(errors).toEqual([])
})

test("Agent activity never adds a status row or resizes the native page", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.getByRole("combobox").waitFor()
  const before = await page.locator(".browser-content:visible").boundingBox()
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.store.applyAgentActivity({
      sessionID: "current",
      operationID: "current-call",
      pageId: "page-two",
      url: "https://example.test/two",
      kind: "acting",
      tool: "browser_navigation",
      label: "Navigating",
    })
    fixture.store.applyAgentActivity({
      sessionID: "other",
      operationID: "other-call",
      pageId: "page-one",
      url: "https://example.test/one",
      kind: "acting",
      tool: "browser_action",
      label: "Clicking",
    })
    fixture.replaceMetadata("page-two", "Destination", "https://example.test/destination")
  })
  expect(await page.locator("[data-browser-agent-status]").count()).toBe(0)
  expect(await page.getByRole("button", { name: "Follow", exact: true }).count()).toBe(0)
  expect(await page.getByRole("combobox").inputValue()).toBe("https://example.test/one")
  expect(await page.locator(".browser-content:visible").boundingBox()).toEqual(before)
  await page.evaluate(() =>
    (window as unknown as Fixture).store.applyAgentActivity({
      sessionID: "current",
      operationID: "current-call",
      pageId: "page-two",
      url: "https://example.test/destination",
      kind: "idle",
      tool: "browser_navigation",
      label: "Idle",
    }),
  )
  expect(await page.locator("[data-browser-agent-status]").count()).toBe(0)
  expect(await page.locator(".browser-content:visible").boundingBox()).toEqual(before)
  expect(errors).toEqual([])
})

test("retained peer panels keep their page and input target through repeated switching and Agent updates", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.getByRole("combobox").waitFor()
  await page.getByRole("button", { name: "Open second", exact: true }).click()
  await page.waitForFunction(() =>
    (window as unknown as Fixture).attachments.some((item) => item.pageId === "page-two"),
  )
  for (let index = 0; index < 6; index++) {
    await page.getByRole("button", { name: "Open first", exact: true }).click()
    expect(await page.getByRole("combobox").inputValue()).toBe("https://example.test/one")
    await page.evaluate(() =>
      (window as unknown as Fixture).store.applyAgentActivity({
        sessionID: "current",
        operationID: "reading",
        tool: "browser_read",
        pageId: "page-two",
        url: "https://example.test/two",
        kind: "acting",
        label: "Reading background",
      }),
    )
    await page.getByRole("button", { name: "Reload", exact: true }).click()
    expect(
      await page.evaluate(
        () => (window as unknown as Fixture).commands.filter((item) => item.type === "reload").at(-1)?.pageId,
      ),
    ).toBe("page-one")
    await page.getByRole("button", { name: "Open second", exact: true }).click()
    expect(await page.getByRole("combobox").inputValue()).toBe("https://example.test/two")
  }
})

test("a delayed profile copy is retained without stealing selection from the next page", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.getByRole("button", { name: "Browser options", exact: true }).click()
  await page.getByRole("button", { name: "Browser settings", exact: true }).click()
  await page.getByText("Separate accounts and advanced settings", { exact: true }).click()
  await page.getByRole("button", { name: "Open this page with this profile", exact: true }).click()
  await page.getByRole("button", { name: "Open second", exact: true }).click()
  await page.evaluate(() => (window as unknown as Window & { finishOpen(): void }).finishOpen())
  await page.locator('[data-page="page-copy"]').waitFor({ state: "attached" })
  expect(await page.getByRole("combobox").inputValue()).toBe("https://example.test/two")
  expect(await page.locator('[data-page="page-copy"]').isVisible()).toBe(false)
  expect(errors).toEqual([])
})

test("metadata updates preserve the address draft, DOM identity and native attachment", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  const address = page.getByRole("combobox")
  await address.waitFor()
  const original = await address.elementHandle()
  await address.fill("unfinished address")
  const before = await page.evaluate(() => ({
    attach: (window as unknown as Fixture).attachments.length,
    detach: (window as unknown as Fixture).detachments.length,
  }))
  await page.evaluate(() =>
    (window as unknown as Fixture).replaceMetadata(
      "page-one",
      "Updated background title",
      "https://example.test/one#updated",
    ),
  )
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await address.inputValue()).toBe("unfinished address")
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  expect(
    await page.evaluate(() => ({
      attach: (window as unknown as Fixture).attachments.length,
      detach: (window as unknown as Fixture).detachments.length,
    })),
  ).toEqual(before)
})

test("a popup failure keeps the page visible with one compact notice and deferred diagnostics", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.some((item) => item.visible))
  await page.evaluate(() =>
    (window as unknown as Fixture).store.setBrowserError({
      pageId: "page-one",
      severity: "error",
      message: "Popup could not open",
    }),
  )
  await page.getByText("Page action failed", { exact: true }).waitFor()
  expect(await page.getByText("Browser issue", { exact: true }).count()).toBe(0)
  expect(await page.getByText("Popup could not open", { exact: true }).count()).toBe(0)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await page.evaluate(() => (window as unknown as Fixture).attachments.at(-1)?.visible)).toBe(true)
  const error = await page.getByText("Page action failed", { exact: true }).boundingBox()
  const surface = await page.locator(".browser-surface").boundingBox()
  expect(error!.y + error!.height).toBeLessThanOrEqual(surface!.y)
  await page.getByRole("button", { name: "Browser options", exact: true }).click()
  await page.getByRole("button", { name: "Error details", exact: true }).click()
  const details = page.getByRole("dialog", { name: "Error details", exact: true })
  await details.getByText("Popup could not open", { exact: true }).waitFor()
  await page.waitForFunction(() => !(window as unknown as Fixture).attachments.at(-1)?.visible)
  await page.keyboard.press("Escape")
  await details.waitFor({ state: "hidden" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Browser options")
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible)
  await page.getByRole("button", { name: "Dismiss message", exact: true }).click()
  expect(await page.getByText("Page action failed", { exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
})

test("the real new-tab import entry opens a dialog while its page is missing and recovers the same target", async () => {
  await page.goto(`${url}?blank&missing`)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.getByRole("button", { name: "Import browser data", exact: true }).click()
  await page.getByRole("dialog", { name: "Import browser data", exact: true }).waitFor()
  await page.getByRole("alert").waitFor()
  expect(await page.evaluate(() => (window as unknown as Fixture).dataRequests)).toEqual([])
  await page.evaluate(() => (window as unknown as Fixture).publishPage())
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByRole("button", { name: "Choose file and import", exact: true }).waitFor()
  const requests = await page.evaluate(() => (window as unknown as Fixture).dataRequests)
  expect(requests.filter((input) => input.action.type === "importSources").map((input) => input.pageId)).toEqual([
    "page-one",
  ])
  expect(requests.some((input) => input.action.type === "import")).toBe(false)
  expect(errors).toEqual([])
})

test("missing native data capability and native failures stay visible through the real import entry", async () => {
  await page.goto(`${url}?blank&no-data`)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.getByRole("button", { name: "Import browser data", exact: true }).click()
  await page.getByRole("dialog", { name: "Import browser data", exact: true }).waitFor()
  await page.getByRole("alert").waitFor()
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.dataUnavailable = false
    fixture.dataFailure = true
  })
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByRole("alert").waitFor()
  await page.evaluate(() => ((window as unknown as Fixture).dataFailure = false))
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByRole("button", { name: "Choose file and import", exact: true }).waitFor()
  expect(errors).toEqual([])
})

test("loading and completion keep content bounds stable and do not focus the address", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.some((item) => item.visible))
  const before = await page.locator(".browser-surface").boundingBox()
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.store.upsertPage({ ...fixture.store.session.pages[0]!, isLoading: true })
  })
  await page.getByRole("progressbar").waitFor()
  expect(await page.locator(".browser-surface").boundingBox()).toEqual(before)
  expect(await page.locator(".browser-address-input").evaluate((node) => node === document.activeElement)).toBe(false)
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    fixture.store.upsertPage({ ...fixture.store.session.pages[0]!, isLoading: false })
  })
  await page.getByRole("progressbar").waitFor({ state: "hidden" })
  expect(await page.locator(".browser-surface").boundingBox()).toEqual(before)
})

test("a disconnected suspended page offers only Resume instead of a duplicate error notice", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.getByRole("combobox").waitFor()
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    const current = fixture.store.session.pages[0]!
    fixture.store.upsertPage({
      ...current,
      status: "suspended",
      navigation: {
        id: "failed-navigation",
        generation: 1,
        revision: 1,
        phase: "failed",
        requestedURL: current.url,
        slow: false,
      },
    })
    fixture.store.setHostStatus(current.id, "detached")
    fixture.store.setSession("connectionStatus", "failed")
    fixture.store.setBrowserError({
      pageId: current.id,
      severity: "error",
      code: "browser_page_error",
      message: "Browser Host broker disconnected.",
    })
  })
  await page.getByText("Page suspended", { exact: true }).waitFor()
  expect(await page.getByText("Browser issue", { exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Resume page", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as Fixture).commands)).toEqual([
    { type: "resume", pageId: "page-one" },
  ])
  expect(errors).toEqual([])
})

test("failed main-frame navigation uses one recovery state, retains page identity, and retries its address", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.some((item) => item.visible))
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    const current = fixture.store.session.pages[0]!
    const navigation = {
      id: "failed-navigation",
      generation: 1,
      revision: 2,
      phase: "failed" as const,
      requestedURL: "https://example.test/destination",
      slow: false,
      error: { code: "browser_load_-324", message: "net::ERR_EMPTY_RESPONSE" },
    }
    fixture.store.upsertPage({ ...current, navigation })
    fixture.store.setBrowserError({ pageId: current.id, navigation, severity: "error", ...navigation.error })
  })
  const state = page.locator(".browser-empty-state:visible")
  await state.getByText("Page could not be loaded", { exact: true }).waitFor()
  expect((await state.innerText()).trim()).toBe("Page could not be loaded\nReload page")
  expect(await state.getByRole("button").count()).toBe(1)
  expect(await page.getByRole("button", { name: "Dismiss message", exact: true }).count()).toBe(0)
  expect(await page.getByText("net::ERR_EMPTY_RESPONSE", { exact: true }).count()).toBe(0)
  await page.waitForFunction(() =>
    (window as unknown as Fixture).detachments.some((item) => item.pageId === "page-one"),
  )
  expect(await page.getByRole("combobox").inputValue()).toBe("https://example.test/destination")
  await page.getByRole("button", { name: "Browser options", exact: true }).click()
  await page.getByRole("button", { name: "Error details", exact: true }).click()
  const details = page.getByRole("dialog", { name: "Error details", exact: true })
  await details.getByText("net::ERR_EMPTY_RESPONSE", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Error details", exact: true }).waitFor({ state: "hidden" })
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await details.getByRole("button", { name: "Copy error details", exact: true }).click()
  await details.getByRole("status").getByText("Copied", { exact: true }).waitFor()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("net::ERR_EMPTY_RESPONSE")
  expect(await details.getByRole("button", { name: "Copy error details", exact: true }).isEnabled()).toBe(true)
  await page.keyboard.press("Escape")
  await details.waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "Open second", exact: true }).click()
  expect(await page.locator(".browser-empty-state:visible").count()).toBe(0)
  await page.getByRole("button", { name: "Browser options", exact: true }).click()
  expect(await page.getByRole("button", { name: "Error details", exact: true }).count()).toBe(0)
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await state.getByRole("button", { name: "Reload page", exact: true }).click()
  expect(await state.getByRole("button", { name: "Reload page", exact: true }).isDisabled()).toBe(true)
  expect(await page.evaluate(() => (window as unknown as Fixture).commands)).toEqual([
    { type: "navigate", pageId: "page-one", source: "user", url: "https://example.test/destination" },
  ])
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    const current = fixture.store.session.pages[0]!
    fixture.store.upsertPage({
      ...current,
      isLoading: false,
      url: "https://example.test/destination",
      navigation: {
        ...current.navigation!,
        id: "reloaded-navigation",
        revision: 3,
        phase: "completed",
        error: undefined,
      },
    })
  })
  await state.waitFor({ state: "hidden" })
  await page.waitForFunction(() => (window as unknown as Fixture).attachments.at(-1)?.visible)
  expect(await page.evaluate(() => (window as unknown as Fixture).store.session.pages.map((item) => item.id))).toEqual([
    "page-one",
    "page-two",
  ])
  expect(errors).toEqual([])
})

test("recovery states fit short and narrow panels across themes and locales, with actionable failure guidance", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).click()
  await page.getByRole("combobox").waitFor()
  await page.evaluate(() => {
    const fixture = window as unknown as Fixture
    const current = fixture.store.session.pages[0]!
    fixture.store.upsertPage({
      ...current,
      navigation: {
        id: "offline-navigation",
        generation: 1,
        revision: 2,
        phase: "failed",
        slow: false,
        requestedURL: current.url,
        error: { code: "browser_load_-106", message: "ERR_INTERNET_DISCONNECTED" },
      },
    })
  })
  const state = page.locator(".browser-empty-state:visible")
  await state
    .getByText("You appear to be offline. Check your connection, then retry this page.", { exact: true })
    .waitFor()
  await page.evaluate(() => document.fonts.ready)
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
    await page.evaluate(() => {
      const fixture = window as unknown as Fixture
      const current = fixture.store.session.pages[0]!
      fixture.store.upsertPage({
        ...current,
        navigation: {
          ...current.navigation!,
          revision: current.navigation!.revision + 1,
          error: { code: "browser_load_-106", message: "ERR_INTERNET_DISCONNECTED" },
        },
      })
    })
    for (const locale of ["en", "zh-CN", "pseudo"]) {
      await page.evaluate((locale) => (window as unknown as Fixture).setLocale(locale), locale)
      for (const width of [900, 375]) {
        await page.setViewportSize({ width, height: 560 })
        await page.locator(".synergy-workbench-canvas").evaluate((element) => (element.style.height = "240px"))
        await state.getByRole("button").scrollIntoViewIfNeeded()
        const geometry = await state.evaluate((element) => {
          const button = element.querySelector("button")!.getBoundingClientRect()
          const surface = element.closest(".browser-surface")!.getBoundingClientRect()
          return {
            fits: button.top >= surface.top && button.bottom <= surface.bottom + 1,
            width: element.clientWidth,
            scroll: element.scrollWidth,
            actions: element.querySelectorAll("button").length,
            summary: element.querySelector(".browser-empty-title")!.textContent,
          }
        })
        expect(geometry.fits).toBe(true)
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1)
        expect(geometry.actions).toBe(1)
        if (locale === "zh-CN") expect(geometry.summary).toBe("页面未能加载")
      }
    }
    if (process.env.SYNERGY_BROWSER_RECOVERY_SHOTS) {
      const output = path.resolve(import.meta.dir, "../../../../../../.artifacts/verify-browser-recovery")
      await mkdir(output, { recursive: true })
      await page
        .locator(".browser-workspace:visible")
        .screenshot({ path: path.join(output, `${scheme}-navigation-narrow.png`) })
      await page.evaluate(() => {
        const fixture = window as unknown as Fixture
        fixture.setLocale("zh-CN")
        const current = fixture.store.session.pages[0]!
        fixture.store.upsertPage({
          ...current,
          navigation: {
            ...current.navigation!,
            revision: current.navigation!.revision + 1,
            error: { code: "browser_load_-324", message: "ERR_EMPTY_RESPONSE" },
          },
        })
      })
      await page.setViewportSize({ width: 900, height: 560 })
      await page.locator(".synergy-workbench-canvas").evaluate((element) => (element.style.height = "440px"))
      await page
        .locator(".browser-workspace:visible")
        .screenshot({ path: path.join(output, `${scheme}-navigation-empty.png`) })
    }
  }
  expect(errors).toEqual([])
})

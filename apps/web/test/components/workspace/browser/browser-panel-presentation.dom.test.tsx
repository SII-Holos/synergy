import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
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
  directory = await mkdtemp(path.join(import.meta.dir, ".browser-panel-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "sdk.ts"),
    `
    export const useSDK = () => ({url:"http://fixture.test",scopeID:"home",client:{browser:{
      session:async () => ({data:{ownerKey:"scope:home:scope",hostStatus:"ready",seq:1,epoch:"epoch-one",pages:window.pages,presentation:window.presentation}})
    }}})
  `,
  )
  await Bun.write(
    path.join(directory, "platform.ts"),
    `
    window.attachments=[]; window.detachments=[];
    export const usePlatform = () => ({browserNative:{
      presentationCapability:async () => ({protocolVersion:5,managedLocal:true,status:"ready"}),
      attachView:async input => window.attachments.push(input), resizeView:async () => {},
      detachView:async input => window.detachments.push(input), focusView:async () => {}, onEvent:() => () => {},
      dataAction:async () => ({type:"state",passwordStorage:true,passwords:[],history:[]}),
      pageAction:async () => ({type:"state",back:false,forward:false,zoom:1})
    }})
  `,
  )
  await Bun.write(
    path.join(directory, "transport.ts"),
    `
    export const createBrowserWebSocket = store => {
      window.deliverPresentation = value => store.setPresentation(value);
      store._setSend(() => {});
      return {createNativeTicket:async () => "ticket", retryNative:() => {}};
    }
  `,
  )
  await Bun.write(
    path.join(directory, "workbench.ts"),
    `
    export const useWorkbenchPanels = () => ({surface:() => ({active:() => window.activeTabId}),openPanel:() => {}})
  `,
  )
  await Bun.write(path.join(directory, "draft.ts"), "export const useBrowserDraft = () => ({})")
  await Bun.write(path.join(directory, "router.ts"), "export const useParams = () => ({})")
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createResource,createSignal,Show,Suspense} from "solid-js"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {BrowserCatalogProvider,useBrowserCatalog} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-catalog.tsx`)}
    import {BrowserPanel} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-panel.tsx`)}
    import {browserPageTab} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-workbench-model.ts`)}
    import {messages} from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    window.presentation={kind:"native",protocolVersion:5,capabilities:{native:true},reason:"desktop-local"};
    window.pages=["one","two"].map(id => ({id:"page-"+id,profileId:"personal",status:"active",url:"https://example.test/"+id,title:id,isLoading:false,lastActiveAt:null}));
    const route={mode:"scope",scopeID:"home",path_directory:"home"};
    const i18n=setupI18n({locale:"en",messages:{en:messages}});
    function Harness() {
      const catalog=useBrowserCatalog();
      const [loaded]=createResource(() => catalog.get(route));
      const [tab,setTab]=createSignal();
      const open=id => {window.activeTabId=id;setTab({id,...browserPageTab(window.pages.find(p=>p.id===id),route)})};
      return <Suspense><Show when={loaded()} keyed>{state => <>
        <output aria-label="Presentation">{state.store.presentation()?.kind ?? "none"}</output>
        <button onClick={() => open("page-one")}>Open first</button>
        <button onClick={() => open("page-two")}>Open second</button>
        <div class="synergy-workbench-canvas" style="height:500px"><Show when={tab()} keyed>{current => <BrowserPanel tab={current} />}</Show></div>
      </>}</Show></Suspense>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><BrowserCatalogProvider><Harness /></BrowserCatalogProvider></DialogProvider></I18nProvider>,document.querySelector("#root"));
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
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

type Fixture = Window & {
  presentation: unknown
  deliverPresentation(value: unknown): void
  attachments: Array<{ pageId: string; visible: boolean }>
}

test("catalog metadata initializes presentation without waiting for an event or allocating a view", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Open first", exact: true }).waitFor()
  expect(await page.getByLabel("Presentation").innerText()).toBe("native")
  expect(await page.evaluate(() => (window as unknown as Fixture).attachments)).toEqual([])
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

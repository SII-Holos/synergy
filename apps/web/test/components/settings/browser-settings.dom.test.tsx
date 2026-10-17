import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"

let root: string, url: string, browser: Browser, page: Page, server: BrowserFixture
const errors: string[] = []
type State = "unknown" | "absent" | "selected" | "remote" | "restarting"
interface FixtureWindow extends Window {
  fixture: {
    select(state: State): void
    counts(): { requests: string[]; native: string[]; probes: number; settledImports: number }
    deepLink(): void
    hold(value: boolean): void
    finish(): void
    changeServer(): void
    holdImport(): void
    finishImport(): void
    openUnrelated(): void
    closeUnrelated(): void
  }
}
beforeAll(async () => {
  root = await mkdtemp(path.join(import.meta.dir, ".browser-settings-"))
  const source = path.resolve(import.meta.dir, "../../../src")
  await Bun.write(path.join(root, "index.html"), '<div id="root"></div><script type="module" src="/main.tsx"></script>')
  await Bun.write(
    path.join(root, "services.ts"),
    `
    import { batch, createSignal } from "solid-js"
    const [selection,setSelection]=createSignal(), [managed,setManaged]=createSignal(true), [status,setStatus]=createSignal("ready"), [serverUrl,setServerUrl]=createSignal("http://same-url.test")
    const counts={requests:[],native:[],probes:0,settledImports:0};let hold=false,finish=()=>{},holdImport=false,finishImport=()=>{}
    const profile={id:"personal",name:"Personal",enabled:true,kind:"persistent",revision:1,createdAt:1,origins:{}}
    const other={...profile,id:"other",name:"Other"}
    export const sdk={get url(){return serverUrl()},capabilities:{current:selection,has:id=>id==="browser" && selection()?.features.includes(id)},client:{browser:{
      session:async ()=>{counts.requests.push("session");return {data:{ownerKey:"scope:home:scope",pages:[]}}},
      profiles:async ()=>{counts.requests.push("profiles");return {data:{profiles:[profile,other],defaultProfileId:"personal"}}},
      dataContext:async input=>{counts.requests.push("dataContext:"+input.browserDataContextInput.profileId);return {data:{contextId:"context-"+input.browserDataContextInput.profileId,profile:input.browserDataContextInput.profileId==="other" ? other : profile}}},
      releaseDataContext:async ()=>{counts.requests.push("release");return {data:true}}
    }}}
    const bridge={
      presentationCapability:async ()=>{counts.probes++;const reply={protocolVersion:${BROWSER_PROTOCOL_VERSION},managedLocal:managed(),status:status()};if(hold) await new Promise(resolve=>finish=resolve);return reply},
      createPresentationTicket:async ()=>({ok:true,protocolVersion:${BROWSER_PROTOCOL_VERSION},ticket:"fixture-ticket"}),
      profileDataAction:async input=>{counts.native.push(input.action.type);if(status()!=="ready" && input.action.type!=="closeContext") throw new Error("Desktop Browser is reconnecting. Retry.");if(input.action.type==="import" && holdImport){await new Promise(resolve=>finishImport=resolve);counts.settledImports++}return input.action.type==="state" ? {type:"state",passwordStorage:true,passwords:[{id:"login",origin:"https://fixture.test",username:"fixture-account"}],history:[]} : input.action.type==="importSources" ? {type:"sources",sources:[{id:"file",browser:"file",mode:"file",kinds:["passwords","cookies"]}]} : input.action.type==="importProgress" ? {type:"progress",phase:"reading",processed:0,total:1} : input.action.type==="import" ? {type:"import",imported:1,skipped:0,failed:0,cancelled:false,issues:[],items:[{kind:"passwords",imported:1,skipped:0,failed:0}]} : {type:"done"}}
    }
    export function useGlobalSDK(){return sdk}
    export function usePlatform(){return {browserNative:bridge}}
    export function select(state){setManaged(state!=="remote");setStatus(state==="restarting" ? "restarting" : "ready");setSelection(state==="unknown" ? undefined : {features:state==="absent" ? [] : ["browser"]})}
    export function fixture(){return {select,counts:()=>structuredClone(counts),hold:value=>hold=value,finish:()=>{hold=false;finish()},changeServer:()=>batch(()=>{setServerUrl("http://another-server.test");select("selected")}),holdImport:()=>holdImport=true,finishImport:()=>{holdImport=false;finishImport()}}}
    sdk.capabilities.load=async ()=>selection()
    sdk.event={listen:()=>()=>{}}
    sdk.client.config={global:async ()=>({data:{}}),diagnostics:async ()=>({data:{issues:[]}}),domain:{list:async ()=>({data:[]})},instructions:{get:async ()=>({data:{content:"saved instructions",maxBytes:100000,source:"global",filename:"AGENTS.md",hasOverride:false}})}}
    export function useGlobalSync(){return {data:{config:{},provider:{all:[],connected:[],connections:{},profiles:{}},provider_auth:{}}}}
    export function useInput(){return {sendShortcut:()=>"enter"}}
    export function useLocale(){return {fmt:{number:value=>String(value),bytes:value=>String(value)},controller:{preview:()=>undefined},locale:()=>"en"}}
    export function useFontPreference(){return {dirty:()=>false,selected:()=>"",discard:()=>{},save:async ()=>true}}
    export function useProductUpdate(){return {desktopStatus:()=>undefined,serverStatus:()=>undefined,surface:"web",busy:()=>false,webNeedsRefresh:()=>false,appVersion:"fixture",serverVersion:()=>"fixture",webRefreshEnabled:false}}
    export function useHolos(){return {state:{identity:{accounts:[]}}}}
    export function useNavigate(){return ()=>{}}
    export function useLocation(){return {pathname:"/home",search:"",hash:""}}
    export function useParams(){return {}}
  `,
  )
  await Bun.write(
    path.join(root, "registry.ts"),
    `export {getSettingsSections,subscribeSettingsSections} from "/@fs/${source}/plugin/registries/settings-registry.ts"`,
  )
  await Bun.write(
    path.join(root, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createEffect,createMemo,createSignal,For,Show,untrack} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider,useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {Dialog} from "@ericsanchezok/synergy-ui/dialog"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {SettingsDialog} from "/@fs/${source}/components/settings/SettingsPanel.tsx"
    import {sdk,usePlatform,fixture,select} from "./services"
    import "@ericsanchezok/synergy-ui/styles"
    import "/@fs/${source}/components/settings/settings-panel.css"
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    function Harness(){
      const [generation,setGeneration]=createSignal(0)
      const dialog=useDialog()
      let unrelated
      window.fixture={...fixture(),deepLink:()=>setGeneration(value=>value+1),openUnrelated:()=>{unrelated=dialog.push(()=><Dialog title="Unrelated dialog"><p>Unrelated content</p></Dialog>)},closeUnrelated:()=>dialog.close(unrelated)}
      createEffect(()=>{const initialTab=generation() ? "browser" : "personalize";untrack(()=>dialog.show(()=><SettingsDialog initialTab={initialTab}/>))})
      return null
    }
    select(new URLSearchParams(location.search).get("state") || "unknown")
    render(()=><I18nProvider i18n={i18n}><ThemeProvider><DialogProvider><Harness /></DialogProvider></ThemeProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root,
    styled: true,
    localized: true,
    aliases: [
      ...["global-sdk", "platform", "global-sync", "input", "locale", "font-preference", "product-update", "holos"].map(
        (name) => ({
          find: new RegExp("^@/context/" + name + "$"),
          replacement: path.join(root, "services.ts"),
        }),
      ),
      { find: "@solidjs/router", replacement: path.join(root, "services.ts") },
      { find: /^@\/plugin$/, replacement: path.join(root, "registry.ts") },
      { find: "@/", replacement: source + "/" },
    ],
  })
  url = server.url
  browser = await chromium.launch({ headless: true })
}, 100000)
afterEach(async () => {
  await page?.close()
})
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (root) await rm(root, { recursive: true, force: true })
})
async function open(state: State) {
  errors.length = 0
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(6000)
  await page.goto(url + "?state=" + state, { waitUntil: "domcontentloaded", timeout: 30000 })
  try {
    await page.getByRole("heading", { name: "Personalize", exact: true }).waitFor({ timeout: 10000 })
  } catch (failure) {
    throw new Error(JSON.stringify({ errors, body: await page.locator("body").innerText() }), { cause: failure })
  }
}
const counts = () => page.evaluate(() => (window as unknown as FixtureWindow).fixture.counts())

test("unknown, absent and remote Browser settings have no navigation, search or deep link and zero data requests", async () => {
  await open("unknown")
  for (const state of ["unknown", "absent", "remote"] as State[]) {
    await page.evaluate((state) => (window as unknown as FixtureWindow).fixture.select(state), state)
    await page.getByLabel("Search settings...").fill("passwords")
    expect(await page.getByRole("button", { name: "Browser", exact: true }).count()).toBe(0)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.deepLink())
    expect(await page.getByRole("heading", { name: "In-app browser", exact: true }).count()).toBe(0)
  }
  expect((await counts()).requests).toEqual([])
  expect((await counts()).native).toEqual([])
  expect(errors).toEqual([])
})

test("selected Browser manages metadata without page calls, preserves drafts and removes its live dialog on same-URL reconnect", async () => {
  await open("selected")
  await page.getByLabel("Global custom instructions", { exact: true }).fill("unsaved-instructions")
  await page.getByRole("button", { name: "Browser", exact: true }).click()
  await page.getByRole("button", { name: "Manage saved passwords", exact: true }).click()
  await page.getByText("fixture-account", { exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Fill login", exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Save current login", exact: true }).count()).toBe(0)
  const before = (await counts()).requests.length
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.select("unknown"))
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.counts().native.includes("closeContext"),
  )
  expect(await page.getByRole("dialog", { name: "Manage saved passwords", exact: true }).count()).toBe(0)
  expect((await counts()).requests).toHaveLength(before)
  await page.getByRole("button", { name: "Personalize", exact: true }).click()
  expect(await page.getByLabel("Global custom instructions", { exact: true }).inputValue()).toBe("unsaved-instructions")
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.select("absent"))
  await page.getByLabel("Search settings...").fill("cookies")
  expect(await page.getByRole("button", { name: "Browser", exact: true }).count()).toBe(0)
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.select("selected"))
  await page.getByRole("button", { name: "Browser", exact: true }).click()
  expect((await counts()).requests.some((request) => /page|control|open/i.test(request))).toBe(false)
  expect(errors).toEqual([])
})

test("Browser settings has exactly two immediate actions and reuses import with a dialog-local persistent target", async () => {
  await open("selected")
  await page.getByLabel("Global custom instructions", { exact: true }).fill("keep-this-draft")
  await page.getByLabel("Search settings...").fill("autofill")
  await page.getByRole("button", { name: "Browser", exact: true }).click()
  await page.getByRole("heading", { name: "In-app browser", exact: true }).waitFor()
  expect(await page.locator("[data-settings-page=browser] .ds-setting-row").count()).toBe(2)
  expect(await page.getByRole("button", { name: "Browser profile", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Import", exact: true }).click()
  const picker = page.getByRole("button", { name: /^Browser profile:/ })
  await picker.waitFor()
  await page.getByRole("button", { name: "Choose file and import", exact: true }).waitFor()
  expect((await counts()).native).not.toContain("import")
  await picker.click()
  await page.getByRole("option", { name: "Other", exact: true }).click()
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.counts().requests.includes("dataContext:other"),
  )
  await page.getByRole("button", { name: "Choose file and import", exact: true }).click()
  await page.getByText("1 imported · 0 skipped · 0 failed", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await page.getByLabel("Search settings...").fill("")
  await page.getByRole("button", { name: "Personalize", exact: true }).click()
  expect(await page.getByLabel("Global custom instructions", { exact: true }).inputValue()).toBe("keep-this-draft")
  expect((await counts()).requests.filter((request) => request.startsWith("dataContext:"))).toEqual([
    "dataContext:personal",
    "dataContext:other",
  ])
  expect((await counts()).native.filter((action) => action === "import")).toHaveLength(1)
  expect((await counts()).requests.some((request) => /page|control|open/i.test(request))).toBe(false)
  expect(errors).toEqual([])
})

test("temporary native broker reconnect keeps settings installed and exposes retry", async () => {
  await open("restarting")
  await page.getByRole("button", { name: "Browser", exact: true }).click()
  await page.getByRole("button", { name: "Manage saved passwords", exact: true }).click()
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor()
  expect(await page.locator(".ds-content-title").filter({ hasText: "In-app browser" }).count()).toBe(1)
  expect((await counts()).requests.some((request) => /page|control|open/i.test(request))).toBe(false)
})

for (const invalidation of ["absent", "same-URL reconnect", "server change"] as const) {
  test(`Browser closes its exact management and delete-confirmation subtree on ${invalidation}`, async () => {
    await open("selected")
    await page.getByLabel("Global custom instructions", { exact: true }).fill("retained-draft")
    await page.getByRole("button", { name: "Browser", exact: true }).click()
    await page.getByRole("button", { name: "Manage saved passwords", exact: true }).click()
    await page.getByText("fixture-account", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Delete saved password", exact: true }).click()
    await page.getByRole("dialog", { name: "Delete saved password", exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.openUnrelated())
    const before = (await counts()).requests.length
    await page.evaluate((reason) => {
      const fixture = (window as unknown as FixtureWindow).fixture
      if (reason === "server change") fixture.changeServer()
      else fixture.select(reason === "absent" ? "absent" : "unknown")
    }, invalidation)
    await page.waitForFunction(() =>
      (window as unknown as FixtureWindow).fixture.counts().native.includes("closeContext"),
    )
    expect(
      await page.getByRole("dialog", { name: "Manage saved passwords", exact: true, includeHidden: true }).count(),
    ).toBe(0)
    expect(
      await page.getByRole("dialog", { name: "Delete saved password", exact: true, includeHidden: true }).count(),
    ).toBe(0)
    expect(await page.getByRole("dialog", { name: "Unrelated dialog", exact: true }).count()).toBe(1)
    expect(await page.getByRole("dialog", { name: "Settings", exact: true, includeHidden: true }).count()).toBe(1)
    expect((await counts()).requests).toHaveLength(before)
    expect((await counts()).native).not.toContain("deletePassword")
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.closeUnrelated())
    await page.getByRole("button", { name: "Personalize", exact: true }).click()
    expect(await page.getByLabel("Global custom instructions", { exact: true }).inputValue()).toBe("retained-draft")
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.select("selected"))
    await page.getByRole("button", { name: "Browser", exact: true }).click()
    await page.getByRole("button", { name: "Manage saved passwords", exact: true }).click()
    await page.getByText("fixture-account", { exact: true }).waitFor()
    expect(await page.getByRole("dialog", { name: "Delete saved password", exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
  })

  test(`Browser cancels its in-progress import and ignores the late result on ${invalidation}`, async () => {
    await open("selected")
    await page.getByLabel("Global custom instructions", { exact: true }).fill("retained-import-draft")
    await page.getByRole("button", { name: "Browser", exact: true }).click()
    await page.getByRole("heading", { name: "In-app browser", exact: true }).waitFor()
    await page.locator("[data-settings-page=browser]").getByRole("button", { name: "Import", exact: true }).click()
    await page.getByRole("button", { name: "Choose file and import", exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.holdImport())
    await page.getByRole("button", { name: "Choose file and import", exact: true }).click()
    await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.counts().native.includes("import"))
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.openUnrelated())
    const before = (await counts()).requests.length
    await page.evaluate((reason) => {
      const fixture = (window as unknown as FixtureWindow).fixture
      if (reason === "server change") fixture.changeServer()
      else fixture.select(reason === "absent" ? "absent" : "unknown")
    }, invalidation)
    await page.waitForFunction(() => {
      const actions = (window as unknown as FixtureWindow).fixture.counts().native
      return actions.includes("cancelImport") && actions.includes("closeContext")
    })
    expect(
      await page.getByRole("dialog", { name: "Import browser data", exact: true, includeHidden: true }).count(),
    ).toBe(0)
    expect(await page.getByRole("dialog", { name: "Unrelated dialog", exact: true }).count()).toBe(1)
    expect((await counts()).requests).toHaveLength(before)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.finishImport())
    await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.counts().settledImports === 1)
    expect(await page.getByText("1 imported · 0 skipped · 0 failed", { exact: true }).count()).toBe(0)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.closeUnrelated())
    await page.getByRole("button", { name: "Personalize", exact: true }).click()
    expect(await page.getByLabel("Global custom instructions", { exact: true }).inputValue()).toBe(
      "retained-import-draft",
    )
    expect(errors).toEqual([])
  })
}

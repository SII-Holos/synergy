import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import type { WorkbenchPanelTab } from "../../src/plugin/registries/workbench-panel-registry"

type Fixture = {
  calls: { panelId: string; options: { init?: { resourceId?: string; source?: string } } }[]
  reads: string[]
  tabs(): WorkbenchPanelTab[]
  active(): string | undefined
  tool(name: string, input: Record<string, unknown>, metadata: Record<string, unknown>, status: string): void
  availability(value: boolean): void
  owner(id: string, scopeID?: string, url?: string): void
  hold(): void
  resolve(): void
  settled(): Promise<void>
  missing(value: boolean): void
  close(): void
  select(): void
  retarget(resourceId: string): void
  switchBack(): void
  reopen(): void
  evidence(part: ToolPart): void
  notes(value: { scopeID: string; notes: { id: string }[]; archived?: boolean }[]): void
  browserPages(value: { id: string; title: string; url: string }[]): void
  sync(value: boolean): void
  revision(): number
}
interface FixtureWindow extends Window {
  fixture: Fixture
}
const resolveUI = createRequire(path.resolve(import.meta.dir, "../../../../packages/ui/package.json"))

let server: ViteDevServer, browser: Browser, page: Page, directory: string, url: string
const source = path.resolve(import.meta.dir, "../../src")
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".tool-resource-open-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "bridge.ts"),
    `
    import {createSignal} from "solid-js"
    import {createStore} from "solid-js/store"
    import {registerWorkbenchPanel} from ${JSON.stringify(`/@fs/${source}/plugin/registries/workbench-panel-registry.ts`)}
    import {setupI18n} from "@lingui/core"
    const surfaces=new Map()
    const surface=(key,name)=>{
      const id=key+":"+name
      if(surfaces.has(id))return surfaces.get(id)
      const [tabs,setTabs]=createSignal([]),[active,setActive]=createSignal(),[opened,setOpened]=createSignal(false),[reveal,setReveal]=createSignal({})
      const value={tabs,setTabs,active,setActive,activeTab:()=>tabs().find(tab=>tab.id===active()),opened,open:()=>setOpened(true),close:()=>setOpened(false),reveal,setReveal}
      surfaces.set(id,value);return value
    }
    const [session,setSession]=createSignal("session"),[scope,setScope]=createSignal("project"),[server,setServer]=createSignal("http://fixture.test")
    const calls=[],reads=[]; let complete; let hold=false; let missing=false; let evidence; let workbench; let pending
    let notes=[{scopeID:"home",notes:[{id:"note"},{id:"one"}]}]
    const route={mode:"scope",scopeID:"project",path_directory:"project"}
    const [catalog,setCatalog]=createStore({session:{pages:[]}}),[sync,setSync]=createSignal(false)
    const register=()=>[
      registerWorkbenchPanel({id:"notes",label:"Notes",icon:"file",surface:"side",cardinality:"multi",beforeCloseTab:async()=>{throw new Error("An existing draft must not be replaced")}}),
      registerWorkbenchPanel({id:"browser",label:"Browser",icon:"globe",surface:"side",cardinality:"multi",async resolveTab(init){
        if(hold){hold=false;await new Promise(resolve=>complete=resolve)}
        if(missing)return
        return {...init,source:"browser-owner"}
      }})
    ]
    let disposers=register()
    registerWorkbenchPanel({id:"execution-detail",label:"Details",icon:"file",surface:"side",cardinality:"singleton"})
    export const fixture=window.fixture={calls,reads,tabs:()=>workbench.surface("side").tabs(),active:()=>workbench.surface("side").active(),
      availability(value){disposers.forEach(dispose=>dispose());disposers=value?register():[]},owner(id,scopeID="project",url="http://fixture.test"){setSession(id);setScope(scopeID);setServer(url)},
      browserPages(value){setCatalog("session","pages",value)},sync:setSync,revision:()=>workbench.surface("side").selectionRevision(),
      hold(){hold=true},resolve(){complete?.();complete=undefined},missing(value){missing=value},close(){workbench.surface("side").close()},
      settled(){return pending},
      retarget(resourceId){workbench.updateTab(workbench.surface("side").active(),{resourceId})},
      switchBack(){const side=workbench.surface("side"),active=side.active();side.setActive("other");side.setActive(active)},
      reopen(){const side=workbench.surface("side");side.close();side.open()},
      select(){workbench.surface("side").setActive("other");workbench.surface("side").open()},evidence(value){evidence=value},notes(value){notes=value}
    }
    export const attachWorkbench=value=>{workbench=value}
    export const useSDK=()=>({get url(){return server()},get scopeKey(){return scope()},get scopeID(){return scope()},client:{
      note:{async listMeta({archived}){reads.push("notes");return {data:notes.filter(group=>!!group.archived===(archived==="true"))}}},
      session:{async toolActivity(){reads.push("evidence");return {data:{part:evidence}}}}
    }})
    export const useParams=()=>({get id(){return session()},get dir(){return scope()+server()}})
    export const useFile=()=>({normalize:value=>value})
    export const usePluginHost=()=>({resources:{register:()=>()=>{}}})
    export const useLayout=()=>({surface,transferWorkbenchState(){}})
    export const useLocale=()=>({i18n:setupI18n({locale:"en",messages:{en:{}}})})
    export const browserRoute=route,isSyncEnabled=sync,useBrowserCatalog=()=>({get:async()=>({route,store:catalog})})
    export const useConfirm=()=>({ask:async()=>true})
    export const useWorkbenchPanels=()=>({...workbench,openPanel(panelId,options){calls.push({panelId,options});return pending=workbench.openPanel(panelId,options)}})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal,createMemo,Show,Suspense} from "solid-js"
    import {createStore} from "solid-js/store"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {DataProvider} from "@ericsanchezok/synergy-ui/context/data"
    import {ActivityTrace} from "@ericsanchezok/synergy-ui/activity-trace"
    import {ResourceOpenProvider} from ${JSON.stringify(`/@fs/${source}/context/resource-open.tsx`)}
    import {WorkbenchPanelsProvider,useWorkbenchPanels} from ${JSON.stringify(`/@fs/${source}/context/workbench/index.tsx`)}
    import {BrowserWorkbenchSync} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-workbench-sync.tsx`)}
    import {fixture,attachWorkbench,browserRoute,isSyncEnabled} from "./bridge"
    const [part,setPart]=createSignal({id:"part",messageID:"message",sessionID:"session",callID:"call",type:"tool",tool:"note_write",state:{status:"completed",input:{},metadata:{id:"note",title:"Note",scopeID:"home"},title:"Note",output:"created",time:{start:1,end:2}}})
    fixture.tool=(tool,input={},metadata={},status="completed")=>setPart({...part(),sessionID:"session",tool,state:{status,input,metadata,title:tool,output:"receipt",error:status==="error"?"Failed":undefined,time:{start:1,end:2}}})
    const [data,setData]=createStore({session:[],message:{},part:{}})
    const group=createMemo(()=>({kind:"group",id:"group",family:"produce",state:part().state.status==="error"?"error":"done",steps:[{part:part(),title:"Open resource",icon:"file-text",state:part().state.status==="error"?"error":"done",family:"produce"}]}))
    function Harness(){attachWorkbench(useWorkbenchPanels());return <><Show when={isSyncEnabled()}><Suspense><BrowserWorkbenchSync route={browserRoute}/></Suspense></Show><ResourceOpenProvider><ActivityTrace group={group()} serverUrl="http://fixture.test"/></ResourceOpenProvider></>}
    render(()=><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><DataProvider data={data} directory={null} serverUrl="http://fixture.test"><WorkbenchPanelsProvider><Harness/></WorkbenchPanelsProvider></DataProvider></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  const bridge = path.join(directory, "bridge.ts")
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid()],
    resolve: {
      alias: [
        { find: "lucide-solid", replacement: resolveUI.resolve("lucide-solid") },
        { find: "./browser-catalog", replacement: bridge },
        ...["@/context/sdk", "@/context/file", "@/context/workbench", "@/plugin/host", "@solidjs/router"].map(
          (find) => ({ find, replacement: bridge }),
        ),
        { find: "../layout", replacement: bridge },
        { find: "@/context/locale", replacement: bridge },
        { find: "@/components/dialog/confirm-dialog", replacement: bridge },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      include: [
        "solid-js",
        "solid-js/web",
        "solid-js/store",
        "@lingui/core",
        "@lingui/solid",
        "zod",
        "fuzzysort",
        "lucide-solid",
      ],
      noDiscovery: true,
    },
    server: {
      hmr: false,
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(source, "../../.."), directory] },
    },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(30000)
  page.setDefaultNavigationTimeout(60000)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
}, 60000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

const facts = () =>
  page.evaluate(() => {
    const f = (window as unknown as FixtureWindow).fixture
    return { calls: f.calls, tabs: f.tabs(), active: f.active(), reads: f.reads }
  })
const tool = async (
  name: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  status = "completed",
) =>
  page.evaluate(
    ({ name, input, metadata, status }) =>
      (window as unknown as FixtureWindow).fixture.tool(name, input, metadata, status),
    {
      name,
      input,
      metadata,
      status,
    },
  )
const row = () => page.locator('[data-slot="activity-step-trigger"]')
const load = async () => {
  errors.length = 0
  try {
    await page.goto(url)
    await row().waitFor()
  } catch (error) {
    throw new Error(`${String(error)}\n${errors.join("\n")}`)
  }
}

test("note writes and edits open their document tab, reuse it and expose selection", async () => {
  await load()
  await row().click()
  expect((await facts()).calls.at(-1)).toMatchObject({
    panelId: "notes",
    options: { init: { resourceId: "note", source: "home" } },
  })
  await page.waitForFunction(
    () => document.querySelector('[data-slot="activity-step-trigger"]')?.getAttribute("aria-pressed") === "true",
  )
  await tool("note_edit", { noteId: "note" }, { id: "note" })
  await row().focus()
  await row().press("Enter")
  expect((await facts()).tabs).toHaveLength(1)
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.close())
  expect(await row().getAttribute("aria-pressed")).toBe("false")
})

test("single-note reads open a document; ambiguous and failed calls retain execution details", async () => {
  await load()
  await tool("note_read", { noteIds: ["one"] }, { count: 1 })
  await row().click()
  expect((await facts()).calls.at(-1)).toMatchObject({ panelId: "notes", options: { init: { resourceId: "one" } } })
  for (const [name, input, metadata, status] of [
    ["note_read", { noteIds: ["one", "two"] }, { count: 2 }, "completed"],
    ["note_write", { noteId: "one" }, { id: "one" }, "error"],
    ["note_edit", { noteId: "one" }, { id: "one", dryRun: true }, "completed"],
    ["note_edit", { noteId: "one" }, { id: "one", errorCode: "conflict" }, "completed"],
    ["note_write", {}, { id: "one", conflict: true }, "completed"],
    ["note_write", {}, { id: "one", blocked: true }, "completed"],
    ["bash", { command: "pwd" }, {}, "completed"],
  ] as const) {
    await tool(name, input, metadata, status)
    await row().click()
    expect((await facts()).calls.at(-1)?.panelId).toBe("execution-detail")
  }
})

test("native Browser operations select the existing page without replaying navigation", async () => {
  await load()
  for (const name of ["browser_navigation", "browser_inspect", "browser_action"]) {
    await tool(name, { action: "open", pageId: "page" }, { pageId: "page", url: "https://example.test" })
    await row().click()
    expect((await facts()).calls.at(-1)).toMatchObject({
      panelId: "browser",
      options: { init: { resourceId: "page" } },
    })
  }
  expect((await facts()).tabs).toHaveLength(1)
  expect(await row().getAttribute("aria-pressed")).toBe("true")
})

test("unavailable, closed and untargeted resources fall back; stale browser completion cannot retarget details", async () => {
  await load()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.availability(false))
  await row().click()
  expect((await facts()).calls.at(-1)?.panelId).toBe("execution-detail")
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.availability(true))
  for (const [input, metadata] of [
    [{ action: "list" }, {}],
    [{ action: "close", pageId: "page" }, { pageId: "page" }],
  ]) {
    await tool("browser_navigation", input, metadata)
    await row().click()
    expect((await facts()).calls.at(-1)?.panelId).toBe("execution-detail")
  }
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.missing(true))
  await tool("browser_navigation", { action: "open" }, { pageId: "page" })
  await row().click()
  await page.waitForFunction(
    () => (window as unknown as FixtureWindow).fixture.calls.at(-1)?.panelId === "execution-detail",
  )
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.hold())
  await row().click()
  await tool("bash", { command: "pwd" }, {})
  await row().click()
  const count = (await facts()).calls.length
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.resolve())
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.settled())
  expect((await facts()).calls).toHaveLength(count)
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.owner("other"))
  await row().click()
  expect((await facts()).calls).toHaveLength(count)
  expect(errors).toEqual([])
})

test("late resource resolution cannot commit after human selection, collapse or owner changes", async () => {
  for (const action of ["select", "switchBack", "close", "reopen", "retarget", "session", "scope", "server"] as const) {
    await load()
    await row().click()
    await page.waitForFunction(() =>
      (window as unknown as FixtureWindow).fixture.tabs().some((tab) => tab.panelId === "notes"),
    )
    await tool("browser_navigation", { action: "open" }, { pageId: "page" })
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.hold())
    await row().click()
    await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.calls.at(-1)?.panelId === "browser")
    await page.evaluate((action) => {
      const f = (window as unknown as FixtureWindow).fixture
      if (action === "select" || action === "switchBack" || action === "close" || action === "reopen") f[action]()
      else if (action === "retarget") f.retarget("__list__")
      else
        f.owner(
          action === "session" ? "other" : "session",
          action === "scope" ? "other" : "project",
          action === "server" ? "http://other.test" : "http://fixture.test",
        )
      f.resolve()
    }, action)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.settled())
    expect((await facts()).tabs.some((tab) => tab.panelId === "browser")).toBe(false)
  }
})

test("historical resource evidence is lazy, identity checked and uses the canonical archived note Scope", async () => {
  await load()
  await tool("note_edit", {}, {})
  expect((await facts()).reads).toEqual([])
  await page.evaluate(() => {
    const f = (window as unknown as FixtureWindow).fixture
    f.notes([{ scopeID: "home", archived: true, notes: [{ id: "archived-note" }] }])
    f.evidence({
      type: "tool",
      id: "part",
      messageID: "message",
      sessionID: "session",
      callID: "call",
      tool: "note_edit",
      state: {
        status: "completed",
        input: { noteId: "archived-note" },
        metadata: { id: "archived-note" },
        title: "Note",
        output: "edited",
        time: { start: 1, end: 2 },
      },
    })
  })
  await row().click()
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.tabs().some((tab) => tab.resourceId === "archived-note"),
  )
  expect((await facts()).calls.at(-1)).toMatchObject({
    panelId: "notes",
    options: { init: { resourceId: "archived-note", source: "home" } },
  })
  expect((await facts()).reads).toEqual(["evidence", "notes", "notes"])
  await load()
  await tool("note_edit", {}, {})
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.evidence({
      type: "tool",
      id: "other-part",
      messageID: "message",
      sessionID: "session",
      callID: "call",
      tool: "note_edit",
      state: {
        status: "completed",
        input: {},
        metadata: { id: "note" },
        title: "Note",
        output: "edited",
        time: { start: 1, end: 2 },
      },
    }),
  )
  await row().click()
  await page.waitForFunction(
    () => (window as unknown as FixtureWindow).fixture.calls.at(-1)?.panelId === "execution-detail",
  )
  expect((await facts()).reads).toEqual(["evidence"])
})

test("missing or ambiguous notes retain execution details, while moved notes use their current Scope", async () => {
  await load()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.notes([]))
  await row().click()
  await page.waitForFunction(
    () => (window as unknown as FixtureWindow).fixture.calls.at(-1)?.panelId === "execution-detail",
  )
  await load()
  await tool("note_write", {}, { id: "note", scopeID: "wrong-owner" })
  await row().click()
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.tabs().some((tab) => tab.panelId === "notes"),
  )
  expect((await facts()).tabs.at(-1)).toMatchObject({ panelId: "notes", resourceId: "note", source: "home" })
  await load()
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.notes([
      { scopeID: "home", notes: [{ id: "note" }] },
      { scopeID: "project", archived: true, notes: [{ id: "note" }] },
    ]),
  )
  await row().click()
  await page.waitForFunction(
    () => (window as unknown as FixtureWindow).fixture.calls.at(-1)?.panelId === "execution-detail",
  )
  expect((await facts()).tabs.some((tab) => tab.panelId === "notes")).toBe(false)
})

test("resource selection follows canonical identity rather than a reused tab ID", async () => {
  await load()
  await row().click()
  await page.waitForFunction(
    () => document.querySelector('[data-slot="activity-step-trigger"]')?.getAttribute("aria-pressed") === "true",
  )
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.retarget("__list__"))
  expect(await row().getAttribute("aria-pressed")).toBe("false")
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.retarget("one"))
  expect(await row().getAttribute("aria-pressed")).toBe("false")
  await row().click()
  await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.tabs().length === 2)
  expect((await facts()).tabs.map((tab) => tab.resourceId)).toEqual(["one", "note"])
})

test("background Browser metadata synchronization preserves a pending tool resource open", async () => {
  await load()
  await row().click()
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.tabs().some((tab) => tab.panelId === "notes"),
  )
  await page.evaluate(() => {
    const f = (window as unknown as FixtureWindow).fixture
    f.browserPages([{ id: "background", title: "Background", url: "about:blank" }])
    f.sync(true)
  })
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.tabs().some((tab) => tab.resourceId === "background"),
  )
  const revision = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.revision())
  await tool("browser_navigation", { action: "open" }, { pageId: "page" })
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.hold())
  await row().click()
  await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.calls.at(-1)?.panelId === "browser")
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.browserPages([
      { id: "background", title: "Updated", url: "https://example.test/updated" },
    ]),
  )
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.tabs().some((tab) => tab.title === "Updated"),
  )
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.revision())).toBe(revision)
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.resolve())
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.settled())
  await page.waitForFunction(() => {
    const f = (window as unknown as FixtureWindow).fixture
    return f.tabs().some((tab) => tab.id === f.active() && tab.resourceId === "page")
  })
  expect(await row().getAttribute("aria-pressed")).toBe("true")
})

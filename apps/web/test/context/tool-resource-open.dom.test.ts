import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { BROWSER_PROTOCOL_VERSION } from "@ericsanchezok/synergy-browser-core"
import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import type { WorkbenchPanelTab } from "../../src/plugin/registries/workbench-panel-registry"
import type {
  OpenableResource,
  ResourceOpenOptions,
  ResourceOpenResult,
  ResourcePreview,
} from "@ericsanchezok/synergy-ui/context/resource-open"

type Fixture = {
  features(features: string[] | undefined): void
  openTool(): boolean
  calls: { panelId: string; options: { init?: { resourceId?: string; source?: string } } }[]
  reads: string[]
  tabs(): WorkbenchPanelTab[]
  active(): string | undefined
  tool(name: string, input: Record<string, unknown>, metadata: Record<string, unknown>, status: string): void
  availability(value: boolean): void
  owner(id: string, scopeID?: string, url?: string): void
  hold(): void
  capabilityDelay(value: number): void
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
  native(
    value: "local" | "remote" | "missing" | "failed" | "incompatible" | "rejected" | "malformed" | "inconsistent",
  ): void
  open(resource: OpenableResource, options?: ResourceOpenOptions): Promise<ResourceOpenResult>
  external: string[]
  preview(resource: OpenableResource, options?: ResourceOpenOptions): Promise<ResourcePreview>
  noteDraft(text: string): void
  fileDraft(text: string): void
  controls: { pageId: string; command: { type: string; url?: string } }[]
  previewContexts: string[]
  openingAttempts: string[]
  openingMode(): void
  platform(value: "web" | "desktop"): void
  nativeEvents: { type: string; prevented: boolean; href: string | null }[]
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
    const [selection,setSelection]=createSignal({features:["note","browser","blueprint","workbench","plugin-host","mcp","media"]})
    const surfaces=new Map()
    const surface=(key,name)=>{
      const id=key+":"+name
      if(surfaces.has(id))return surfaces.get(id)
      const [tabs,setTabs]=createSignal([]),[active,setActive]=createSignal(),[opened,setOpened]=createSignal(false),[reveal,setReveal]=createSignal({})
      const value={tabs,setTabs,active,setActive,activeTab:()=>tabs().find(tab=>tab.id===active()),opened,open:()=>setOpened(true),close:()=>setOpened(false),reveal,setReveal}
      surfaces.set(id,value);return value
    }
    const [session,setSession]=createSignal("session"),[scope,setScope]=createSignal("project"),[server,setServer]=createSignal("http://fixture.test")
    const calls=[],reads=[],external=[],controls=[],nativeEvents=[]; let complete; let hold=false; let missing=false; let evidence; let workbench; let pending; let native="missing"; let pageSequence=0; let platform="desktop"
    let capabilityDelay=0; const bridges=new Map()
    let notes=[{scopeID:"home",notes:[{id:"note"},{id:"one"}]}],noteDraft,fileDraft
    const route={mode:"scope",scopeID:"project",path_directory:"project"}
    const [catalog,setCatalog]=createStore({session:{pages:[]}}),[sync,setSync]=createSignal(false)
    const register=()=>[
      registerWorkbenchPanel({id:"notes",label:"Notes",icon:"file",surface:"side",cardinality:"multi",beforeCloseTab:async()=>{throw new Error("An existing draft must not be replaced")}}),
      registerWorkbenchPanel({id:"browser",label:"Browser",icon:"globe",surface:"side",cardinality:"multi",async resolveTab(init){
        if(hold){hold=false;await new Promise(resolve=>complete=resolve)}
        if(missing)return
        const url=init.state?.url
        if(url){
          const page={id:"linked-"+(++pageSequence),url,title:url,status:"active",profileId:"personal"}
          setCatalog("session","pages",pages=>[...pages,page])
          return {...init,resourceId:page.id,source:"browser-owner",state:{browserRoute:route,browserURL:url}}
        }
        return {...init,source:"browser-owner"}
      }})
    ]
    let disposers=register()
    const openingAttempts=[],openingResults=new Map()
    function openingMode(){disposers.forEach(dispose=>dispose());disposers=[registerWorkbenchPanel({id:"browser",label:"Browser",icon:"globe",surface:"side",cardinality:"multi",openingComponent:()=>null,async resolveTab(init,context){openingAttempts.push(context.requestId);let page=openingResults.get(context.requestId);if(!page){page={id:"unknown-page",url:init.state.url,title:"Created page",status:"active",profileId:"personal"};openingResults.set(context.requestId,page);setCatalog("session","pages",[page]);throw new Error("Native response lost after creation")}return {...init,resourceId:page.id,source:"browser-owner",state:{browserRoute:route,browserURL:page.url}}}})]}
    registerWorkbenchPanel({id:"execution-detail",label:"Details",icon:"file",surface:"side",cardinality:"singleton"})
    export const fixture=window.fixture={calls,reads,external,controls,nativeEvents,platform:value=>platform=value,openingAttempts,openingMode,native:value=>native=value,features:features=>setSelection(features ? {features} : undefined),tabs:()=>workbench.surface("side").tabs(),active:()=>workbench.surface("side").active(),
      availability(value){disposers.forEach(dispose=>dispose());disposers=value?register():[]},owner(id,scopeID="project",url="http://fixture.test"){setSession(id);setScope(scopeID);setServer(url)},
      browserPages(value){setCatalog("session","pages",value)},sync:setSync,revision:()=>workbench.surface("side").selectionRevision(),
      capabilityDelay(value){capabilityDelay=value},hold(){hold=true},resolve(){complete?.();complete=undefined},missing(value){missing=value},close(){workbench.surface("side").close()},
      settled(){return pending},
      retarget(resourceId){workbench.updateTab(workbench.surface("side").active(),{resourceId})},
      switchBack(){const side=workbench.surface("side"),active=side.active();side.setActive("other");side.setActive(active)},
      reopen(){const side=workbench.surface("side");side.close();side.open()},
      select(){workbench.surface("side").setActive("other");workbench.surface("side").open()},evidence(value){evidence=value},notes(value){notes=value},noteDraft:text=>noteDraft=text,fileDraft:text=>fileDraft=text
    }
    export const attachWorkbench=value=>{workbench=value}
    export const useGlobalSDK=()=>({capabilities:{current:selection,has:id=>selection()?.features.includes(id)??false},event:{listen:()=>()=>{}}})
    export const useSDK=()=>({get url(){return server()},get scopeKey(){return scope()},get scopeID(){return scope()},client:{
      note:{async listMeta({archived}){reads.push("notes");return {data:notes.filter(group=>!!group.archived===(archived==="true"))}},async get(){reads.push("note-body");return {data:{title:"Saved note",content:{type:"doc",content:[{type:"paragraph",attrs:{blockId:"block"},content:[{type:"text",text:"Saved note body"}]}]}}}}},
      browser:{async preview(input){reads.push("web-preview");if(hold){hold=false;await new Promise(resolve=>complete=resolve)}return {data:{title:"Public article",source:"example.test",description:"Anonymous summary"}}},async session(){return {data:{ownerKey:"browser-owner",pages:catalog.session.pages}}},async control({browserControlRequest}){controls.push(browserControlRequest);if(browserControlRequest.command.type!=="navigate")throw new Error("Unsupported fixture navigation");setCatalog("session","pages",page=>page.id===browserControlRequest.pageId,"url",browserControlRequest.command.url);return {data:{}}}},
      asset:{async get(input,options){reads.push("asset-body");return {data:new ReadableStream({pull(controller){controller.enqueue(new TextEncoder().encode("Asset excerpt\\n".repeat(4000)))},cancel(){reads.push("asset-cancelled")}})}}},
      workspace:{files:{async stat(input){reads.push("file-stat");return {data:{type:"file",binary:input.path.endsWith(".png")}}},async read(input){reads.push(JSON.stringify(input));return {data:{kind:"text",content:"Saved file body",range:{startLine:input.offset+1}}}}}},
      session:{async toolActivity(){reads.push("evidence");return {data:{part:evidence}}}}
    }})
    export const useParams=()=>({get id(){return session()},get dir(){return scope()+server()}})
    export const useFile=()=>({normalize:value=>value,workspace:{id:"wsp_fixture",generation:2,scopeID:"project",type:"local",path:"/fixture"}})
    export const useProjectFiles=()=>({open:async()=>undefined,peek:()=>fileDraft===undefined?undefined:{draft:{content:fileDraft}}})
    export const usePlatform=()=>({
      get platform(){return platform},
      openLink(url){external.push(url)},
      get browserNative(){
        if(native==="missing")return undefined
        if(bridges.has(native))return bridges.get(native)
        const bridge={async createPresentationTicket(){return {ok:true,ticket:"fixture-ticket"}},async presentationCapability(){
          reads.push("native-capability"); if(capabilityDelay)await new Promise(resolve=>setTimeout(resolve,capabilityDelay))
          if(native==="failed")throw new Error("Native bridge disconnected")
          if(native==="incompatible")return {protocolVersion:6,managedLocal:false,status:"failed",error:{code:"browser_native_ticket_rejected",message:"The Browser native capability request was invalid.",retryable:false}}
          if(native==="rejected")return {protocolVersion:${BROWSER_PROTOCOL_VERSION},managedLocal:false,status:"failed",error:{code:"browser_native_sender_rejected",message:"The Browser native capability request was rejected.",retryable:false}}
          if(native==="malformed")return {managedLocal:false,status:"ready"}
          if(native==="inconsistent")return {protocolVersion:${BROWSER_PROTOCOL_VERSION},managedLocal:false,status:"ready"}
          return {protocolVersion:${BROWSER_PROTOCOL_VERSION},managedLocal:native==="local",status:native==="local"?"ready":"failed"}
        }}
        bridges.set(native,bridge); return bridge
      }
    })
    export const useNoteDocuments=()=>({peek:()=>noteDraft===undefined?undefined:{title:()=>"Unsaved note",content:()=>({type:"doc",content:[{type:"paragraph",attrs:{blockId:"block"},content:[{type:"text",text:noteDraft}]}]})}})
    export const useSync=()=>({data:{session:[],message:{},part:{},workspaces:[]}})
    export const useSessionTransition=()=>({get:()=>undefined}),draftTransitionKey=(server,scope)=>JSON.stringify([server,scope])
    export const usePluginHost=()=>({resources:{register:()=>()=>{}}})
    export const useLayout=()=>({surface,transferWorkbenchState(){}})
    export const useLocale=()=>({i18n:setupI18n({locale:"en",messages:{en:{}}})})
    export const browserRoute=route,isSyncEnabled=sync,useBrowserCatalog=()=>({get:async()=>({route,store:catalog}),peek:()=>({route,store:catalog})})
    export const useConfirm=()=>({ask:async()=>true})
    export const useWorkbenchPanels=()=>({...workbench,openPanel(panelId,options){calls.push({panelId,options});return pending=workbench.openPanel(panelId,options)}})
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal,createMemo,createEffect,onMount,onCleanup,Show,Suspense} from "solid-js"
    import {createStore} from "solid-js/store"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {Toast} from "@ericsanchezok/synergy-ui/toast"
    import {DataProvider} from "@ericsanchezok/synergy-ui/context/data"
    import {useResourceOpen} from "@ericsanchezok/synergy-ui/context/resource-open"
    import {ActivityTrace} from "@ericsanchezok/synergy-ui/activity-trace"
    import {observeMarkdownResources} from ${JSON.stringify(`/@fs/${path.resolve(source, "../../../packages/ui/src/components/markdown-resources.ts")}`)}
    import {ResourceOpenProvider} from ${JSON.stringify(`/@fs/${source}/context/resource-open.tsx`)}
    import {WorkbenchPanelsProvider,useWorkbenchPanels} from ${JSON.stringify(`/@fs/${source}/context/workbench/index.tsx`)}
    import {BrowserWorkbenchSync} from ${JSON.stringify(`/@fs/${source}/components/workspace/browser/browser-workbench-sync.tsx`)}
    import {fixture,attachWorkbench,browserRoute,isSyncEnabled} from "./bridge"
    const [part,setPart]=createSignal({id:"part",messageID:"message",sessionID:"session",callID:"call",type:"tool",tool:"note_write",state:{status:"completed",input:{},metadata:{id:"note",title:"Note",scopeID:"home"},title:"Note",output:"created",time:{start:1,end:2}}})
    fixture.tool=(tool,input={},metadata={},status="completed")=>setPart({...part(),sessionID:"session",tool,state:{status,input,metadata,title:tool,output:"receipt",error:status==="error"?"Failed":undefined,time:{start:1,end:2}}})
    const [data,setData]=createStore({session:[],message:{},part:{}})
    const group=createMemo(()=>({kind:"group",id:"group",family:"produce",state:part().state.status==="error"?"error":"done",steps:[{part:part(),title:"Open resource",icon:"file-text",state:part().state.status==="error"?"error":"done",family:"produce"}]}))
    function NativeLinks(){const resources=useResourceOpen();let root;onMount(()=>{const dispose=observeMarkdownResources(root,resources);const record=event=>{if(event.target.closest("a#native-link"))queueMicrotask(()=>fixture.nativeEvents.push({type:event.type,prevented:event.defaultPrevented,href:event.target.closest("a").getAttribute("href")}))};for(const type of ["click","auxclick","contextmenu","keydown"])document.addEventListener(type,record);onCleanup(()=>{dispose();for(const type of ["click","auxclick","contextmenu","keydown"])document.removeEventListener(type,record)})});return <div ref={root}><a id="native-link" href={location.origin+"/native?doc=first#section"} target="_blank" rel="noopener noreferrer">Native web target</a></div>}
    function Controls(){const resources=useResourceOpen();fixture.previewContexts=[];createEffect(()=>fixture.previewContexts.push(resources.contextKey()));fixture.open=(resource,options)=>resources.open(resource,options);fixture.preview=(resource,options)=>resources.preview(resource,options);fixture.openTool=()=>resources.openToolActivity({sessionID:"session",messageID:"message",partID:"part",callID:"call"},part());return <><ActivityTrace group={group()} serverUrl="http://fixture.test"/><NativeLinks/></>}
    function Harness(){attachWorkbench(useWorkbenchPanels());return <><Toast.Region/><Show when={isSyncEnabled()}><Suspense><BrowserWorkbenchSync route={browserRoute}/></Suspense></Show><ResourceOpenProvider><Controls/></ResourceOpenProvider></>}
    render(()=><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DialogProvider><DataProvider data={data} directory={null} serverUrl="http://fixture.test" hasFeature={() => true}><WorkbenchPanelsProvider><Harness/></WorkbenchPanelsProvider></DataProvider></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  const bridge = path.join(directory, "bridge.ts")
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [
      solid(),
      {
        name: "native-link-destination",
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (!request.url?.startsWith("/native?")) return next()
            response.setHeader("Content-Type", "text/html")
            response.end("<title>Native destination</title><p>Destination</p>")
          })
        },
      },
    ],
    resolve: {
      alias: [
        { find: "./global-sdk", replacement: bridge },
        { find: "lucide-solid", replacement: resolveUI.resolve("lucide-solid") },
        { find: "./browser-catalog", replacement: bridge },
        { find: "./platform", replacement: bridge },
        { find: "@/components/note/documents", replacement: bridge },
        { find: "@/components/workspace/browser/browser-catalog", replacement: bridge },
        ...[
          "@/context/sdk",
          "@/context/platform",
          "@/context/layout",
          "@/context/global-sdk",
          "@/context/file",
          "@/context/workbench",
          "@/context/sync",
          "@/context/session-transition",
          "@/plugin/host",
          "@solidjs/router",
        ].map((find) => ({ find, replacement: bridge })),
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
  await page.goto(url)
  expect(errors).toEqual([])
  expect(await page.locator("#root").evaluate((element) => element.childElementCount)).toBeGreaterThan(0)
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
  await tool("browser_navigation", { action: "open" }, { pageId: "background" })
  await row().click()
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.tabs().some((tab) => tab.resourceId === "background"),
  )
  await tool("note_write", {}, { id: "note" })
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

test("a captured tool action cannot open a removed owner or request its resource", async () => {
  await page.goto(url)
  await row().waitFor()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.features([]))
  const opened = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.openTool())
  expect(opened).toBe(false)
  expect((await facts()).reads).toEqual([])
  expect((await facts()).calls).toEqual([])
})

test("message URLs open the native Browser, reuse only their local tab and preserve explicit external intent", async () => {
  await load()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.native("local"))
  const target = "https://github.com/example/repo/blob/abc/index.ts#L2-L8"
  const open = (url: string, prefer?: ResourceOpenOptions["prefer"]) =>
    page.evaluate(
      ({ url, prefer }) => (window as unknown as FixtureWindow).fixture.open({ kind: "url", url }, { prefer }),
      { url, prefer },
    )
  expect(await open(target)).toEqual({ status: "opened" })
  expect((await facts()).tabs.filter((tab) => tab.panelId === "browser")).toHaveLength(1)
  expect(await open(target)).toEqual({ status: "opened" })
  expect((await facts()).tabs.filter((tab) => tab.panelId === "browser")).toHaveLength(1)
  expect(await open(target, "external")).toEqual({ status: "dispatched" })
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.external)).toEqual([target])
  expect(await open("mailto:person@example.test")).toEqual({ status: "dispatched" })
  expect((await facts()).tabs.filter((tab) => tab.panelId === "browser")).toHaveLength(1)
})

test("a prepared native capability opens the next URL before the next frame", async () => {
  await load()
  await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    f.native("local")
    await f.open({ kind: "url", url: "https://example.test/first" })
    f.capabilityDelay(100)
  })
  const first = await page.evaluate(() => {
    const f = (window as unknown as FixtureWindow).fixture
    void f.open({ kind: "url", url: "https://example.test/next" })
    return new Promise((resolve) =>
      requestAnimationFrame(() => resolve(f.tabs().find((tab) => tab.id === f.active())?.state)),
    )
  })
  expect(first).toMatchObject({ browserURL: "https://example.test/next" })
})

test("unmounted or unsupported native Browser stays external; a broken selected bridge does not silently fall back", async () => {
  for (const mode of ["missing", "remote", "failed", "local"] as const) {
    await load()
    await page.evaluate((mode) => {
      const f = (window as unknown as FixtureWindow).fixture
      f.native(mode)
      if (mode === "local") f.features([])
    }, mode)
    const result = await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.open({ kind: "url", url: "https://example.test/article" }),
    )
    expect(result.status).toBe(mode === "failed" ? "unavailable" : "dispatched")
    expect((await facts()).tabs).toHaveLength(0)
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.external.length)).toBe(
      mode === "failed" ? 0 : 1,
    )
  }
})

test("selected Browser rejects incompatible, rejected and malformed capabilities without silent external navigation", async () => {
  for (const mode of ["incompatible", "rejected", "malformed", "inconsistent"] as const) {
    await load()
    await page.evaluate((mode) => (window as unknown as FixtureWindow).fixture.native(mode), mode)
    const result = await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.open({ kind: "url", url: "https://example.test/protocol" }),
    )
    expect(result.status).toBe("unavailable")
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.external)).toEqual([])
    expect((await facts()).tabs).toEqual([])
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor()
    await page.getByRole("button", { name: "Open in system browser", exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.external)).toEqual([
      "https://example.test/protocol",
    ])
  }
  await load()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.native("incompatible"))
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.open({ kind: "url", url: "https://example.test/retry" }),
  )
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.native("local"))
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.tabs().some((tab) => tab.panelId === "browser"),
  )
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.external)).toEqual([])
})

test("pure Web URLs retain native modifier, middle, keyboard and context-menu anchor behavior", async () => {
  const target = new URL("/native?doc=first#section", url).href
  for (const selected of [true, false]) {
    await load()
    await page.evaluate((selected) => {
      const f = (window as unknown as FixtureWindow).fixture
      f.platform("web")
      f.native(selected ? "local" : "missing")
      if (!selected) f.features([])
    }, selected)
    const link = page.locator("#native-link")
    const source = page.url()
    const tabModifier = process.platform === "darwin" ? "Meta" : "Control"
    for (const input of ["ordinary", tabModifier, "middle", "keyboard"] as const) {
      const popup = page
        .context()
        .waitForEvent("page")
        .catch(async (error) => {
          const facts = await page.evaluate(() => {
            const f = (window as unknown as FixtureWindow).fixture
            return { events: f.nativeEvents, calls: f.calls, external: f.external, focused: document.hasFocus() }
          })
          throw new Error(`${selected}:${input}: ${String(error)}; facts=${JSON.stringify(facts)}`)
        })
      if (input === "keyboard") {
        await link.focus()
        await page.keyboard.press("Enter")
      } else if (input === "middle") await link.click({ button: "middle" })
      else await link.click({ modifiers: input === "ordinary" ? [] : [input] })
      const opened = await popup
      await opened.waitForURL(target).catch((error) => {
        throw new Error(`${input}: URL=${opened.url()}; source=${page.url()}; ${String(error)}`)
      })
      expect(opened.url()).toBe(target)
      await opened.getByText("Destination", { exact: true }).waitFor()
      expect(await opened.title()).toBe("Native destination")
      await opened.close()
      expect(page.url()).toBe(source)
      expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeEvents.at(-1))).toMatchObject(
        {
          prevented: false,
          href: target,
        },
      )
    }
    await link.click({ modifiers: [process.platform === "darwin" ? "Control" : "Meta"] })
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeEvents.at(-1))).toMatchObject({
      prevented: false,
      href: target,
    })
    await page.keyboard.press("Escape")
    await link.click({ button: "right" })
    expect(await link.getAttribute("href")).toBe(target)
    expect(
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.nativeEvents
          .filter((event) => event.type === "contextmenu")
          .at(-1),
      ),
    ).toMatchObject({
      type: "contextmenu",
      prevented: false,
      href: target,
    })
    await page.keyboard.press("Escape")
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.external)).toEqual([])
    expect((await facts()).calls).toEqual([])
    expect((await facts()).tabs).toEqual([])
  }
  await load()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.native("local"))
  await page.locator("#native-link").click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] })
  await page.waitForFunction(() =>
    (window as unknown as FixtureWindow).fixture.tabs().some((tab) => tab.panelId === "browser"),
  )
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.nativeEvents.at(-1))).toMatchObject({
    prevented: true,
    href: target,
  })
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.external)).toEqual([])
})

test("a slow message URL open cannot add a Browser tab to a later human selection or Session", async () => {
  for (const action of ["select", "session"] as const) {
    await load()
    await page.evaluate(() => {
      const f = (window as unknown as FixtureWindow).fixture
      f.native("local")
      f.hold()
      void f.open({ kind: "url", url: "https://example.test/slow" })
    })
    await page.waitForFunction(() =>
      (window as unknown as FixtureWindow).fixture.calls.some((call) => call.panelId === "browser"),
    )
    await page.evaluate((action) => {
      const f = (window as unknown as FixtureWindow).fixture
      if (action === "select") f.select()
      else f.owner("next-session")
      f.resolve()
    }, action)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.settled())
    expect((await facts()).tabs.filter((tab) => tab.panelId === "browser")).toHaveLength(0)
  }
})

test("Note references share current Scope resolution and carry one-shot block navigation without replacing drafts", async () => {
  await load()
  const result = await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.open({
      kind: "note",
      id: "note",
      location: { kind: "heading", id: "block" },
    }),
  )
  expect(result.status).toBe("opened")
  const tab = (await facts()).tabs.find((tab) => tab.panelId === "notes")
  expect(tab?.source).toBe("home")
  expect(tab?.state).toMatchObject({ referenceLocation: { kind: "heading", id: "block" } })
  expect((await facts()).reads).not.toContain("note-body")
})

test("previews are lazy, prefer live Note and file drafts, and never choose an unknown historical Workspace", async () => {
  await load()
  expect((await facts()).reads).toEqual([])
  const preview = await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    f.noteDraft("Unsaved target section")
    f.fileDraft("First\nUnsaved target line\nThird")
    return {
      note: await f.preview({ kind: "note", id: "note", location: { kind: "heading", id: "block" } }),
      file: await f.preview(
        { kind: "workspace-file", path: "index.ts", location: { kind: "text", line: 2 } },
        {
          context: { state: "bound", workspace: { id: "wsp_fixture", generation: 2, root: "/fixture" }, directory: "" },
        },
      ),
      unknown: await f.preview({ kind: "workspace-file", path: "index.ts" }, { context: { state: "unresolved" } }),
    }
  })
  expect(preview.note.title).toBe("Unsaved note")
  expect(preview.note.description).toContain("Unsaved target section")
  expect(preview.file.code?.text).toContain("Unsaved target line")
  expect(preview.unknown.unavailable).toBeTruthy()
  expect((await facts()).reads).not.toContain("note-body")
  expect((await facts()).reads.every((read) => read === "notes")).toBe(true)
  expect((await facts()).tabs).toHaveLength(0)
})

test("different fragments navigate one suitable current tab while query targets and new-tab intent remain distinct", async () => {
  await load()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.native("local"))
  await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    await f.open({ kind: "url", url: "https://example.test/article?view=source#first" })
    await f.open({ kind: "url", url: "https://example.test/article?view=source#second" })
  })
  expect((await facts()).tabs).toHaveLength(1)
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.controls)).toMatchObject([
    { command: { type: "navigate", url: "https://example.test/article?view=source#second" } },
  ])
  await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    await f.open({ kind: "url", url: "https://example.test/article?view=rendered#second" })
    await f.open({ kind: "url", url: "https://example.test/article?view=source#second" }, { newTab: true })
  })
  expect((await facts()).tabs).toHaveLength(3)
})

test("anonymous URL preview uses one lazy request, never opens a page, and respects capability removal", async () => {
  await load()
  const preview = await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    const target = { kind: "url" as const, url: "https://example.test/article#section" }
    const [first, second] = await Promise.all([f.preview(target), f.preview(target)])
    f.features([])
    return { first, second, absent: await f.preview(target) }
  })
  expect(preview.first.title).toBe("Public article")
  expect(preview.second.description).toBe("Anonymous summary")
  expect(preview.absent.unavailable).toBeTruthy()
  expect((await facts()).reads).toEqual(["web-preview"])
  expect((await facts()).tabs).toHaveLength(0)
})

test("image references expose a resolved thumbnail and authored name without allocating a reader", async () => {
  await load()
  const previews = await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    return {
      asset: await f.preview({ kind: "asset", url: "asset://0123456789abcdef.png", filename: "Keyboard sequence" }),
      file: await f.preview(
        { kind: "workspace-file", path: "screens/example.png" },
        {
          context: { state: "bound", workspace: { id: "wsp_fixture", generation: 2, root: "/fixture" }, directory: "" },
        },
      ),
    }
  })
  expect(previews.asset).toMatchObject({
    title: "Keyboard sequence",
    image: { src: "http://fixture.test/asset/0123456789abcdef.png", alt: "Keyboard sequence" },
  })
  expect(previews.file.image?.src).toContain("wsp_fixture")
  expect(previews.file.image?.src).toContain("/wsp_fixture/2/screens/example.png")
  expect(previews.file.title).toBe("example.png")
  expect((await facts()).reads).toEqual(["file-stat"])
  expect((await facts()).tabs).toHaveLength(0)
})

test("text Assets provide a bounded excerpt and cancel the remaining stream", async () => {
  await load()
  const preview = await page.evaluate(() =>
    (window as unknown as FixtureWindow).fixture.preview({
      kind: "asset",
      url: "asset://0123456789abcdef.txt",
      filename: "Notes.txt",
    }),
  )
  expect(preview.title).toBe("Notes.txt")
  expect(preview.code?.text).toBe(Array(11).fill("Asset excerpt").join("\n"))
  expect((await facts()).reads).toEqual(["asset-body", "asset-cancelled"])
  expect((await facts()).tabs).toHaveLength(0)
})

test("text Asset excerpts follow the cited line and retain each link's authored title", async () => {
  await load()
  const previews = await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    const target = {
      kind: "asset" as const,
      url: "asset://0123456789abcdef.txt",
      location: { kind: "text" as const, line: 42 },
    }
    return [
      await f.preview({ ...target, filename: "First excerpt" }),
      await f.preview({ ...target, filename: "Second excerpt" }),
    ]
  })
  expect(previews.map((preview) => preview.code?.startLine)).toEqual([39, 39])
  expect(previews.map((preview) => preview.title)).toEqual(["First excerpt", "Second excerpt"])
  expect((await facts()).reads).toEqual(["asset-body", "asset-cancelled"])
})

test("a late preview response cannot transfer across an A-to-B-to-A Session change", async () => {
  await load()
  const cancelled = await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    f.hold()
    const result = f.preview({ kind: "url", url: "https://example.test/held" }).then(
      () => false,
      () => true,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.owner("other")
    f.owner("session")
    f.resolve()
    return result
  })
  expect(cancelled).toBe(true)
  expect((await facts()).tabs).toHaveLength(0)
})

test("identical Note previews share metadata resolution and body reads without allocating a tab", async () => {
  await load()
  const previews = await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    const target = { kind: "note" as const, id: "note", location: { kind: "heading" as const, id: "block" } }
    return Promise.all([f.preview(target), f.preview(target)])
  })
  expect(previews.map((preview) => preview.description)).toEqual(["Saved note body", "Saved note body"])
  expect((await facts()).reads).toEqual(["notes", "notes", "note-body"])
  expect((await facts()).tabs).toHaveLength(0)
})

test("a selected native Browser preparation failure reports unavailable without silently opening externally", async () => {
  await load()
  const result = await page.evaluate(async () => {
    const f = (window as unknown as FixtureWindow).fixture
    f.native("local")
    f.missing(true)
    return f.open({ kind: "url", url: "https://example.test/missing" })
  })
  expect(result.status).toBe("unavailable")
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.external)).toEqual([])
})

test("human Workspace selection reactively invalidates an open reference preview context", async () => {
  await load()
  const result = await page.evaluate(async () => {
    const fixture = (window as unknown as FixtureWindow).fixture
    const before = fixture.previewContexts.length
    fixture.select()
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { before, contexts: fixture.previewContexts }
  })
  expect(result.contexts.length).toBeGreaterThan(result.before)
  expect(result.contexts.at(-1)).not.toBe(result.contexts.at(-2))
})

test("message URL toast Retry reuses an unknown Browser creation request and its single peer tab", async () => {
  await load()
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).fixture
    fixture.native("local")
    fixture.openingMode()
    void fixture.open({ kind: "url", url: "https://example.test/unknown-response" })
  })
  await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.openingAttempts.length === 1)
  const original = await page.evaluate(() => (window as unknown as FixtureWindow).fixture.tabs()[0]!.id)
  await page.getByRole("button", { name: "Retry", exact: true }).click({ timeout: 5000 })
  await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.openingAttempts.length === 2)
  const result = await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).fixture
    fixture.resolve()
    return { attempts: fixture.openingAttempts, tabs: fixture.tabs() }
  })
  expect(result.attempts[1]).toBe(result.attempts[0])
  expect(result.tabs).toHaveLength(1)
  expect(result.tabs[0]).toMatchObject({ id: original, resourceId: "unknown-page" })
  expect(errors).toEqual([])
})

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { preview, type PreviewServer } from "vite"
import type { NoteDocumentController } from "../../../src/components/note/document-controller"

type ReadingFixture = {
  controller(): NoteDocumentController
  state(): { referenceNavigation?: string; referenceLocation?: { kind: string; id: string } }
  navigate(blockId: string | undefined, sequence: string): void
  setActive(active: boolean): void
  holdWrites(): void
  emit(): void
  writes: unknown[]
  copies: string[]
}

let browser: Browser
let page: Page
let server: PreviewServer
let directory: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "synergy-note-reading-")))
  await symlink(path.resolve(source, "../node_modules"), path.join(directory, "node_modules"), "dir")
  await Bun.write(path.join(directory, "package.json"), '{"type":"module"}')
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import {useLingui} from "@lingui/solid"
    import {createSignal} from "solid-js"
    import {createStore} from "solid-js/store"
    const [reconnect,setReconnect]=createSignal(0)
    const plain=new URLSearchParams(location.search).has("plain")
    const paragraph=(text,blockId)=>({type:"paragraph",...(blockId?{attrs:{blockId}}:{}),content:[{type:"text",text}]})
    let note={id:"reading",scopeID:"home",title:"Blueprint: 阅读和编辑的连续性",kind:plain?"note":"blueprint",version:1,tags:["reading"],pinned:false,global:false,archived:false,time:{created:1,updated:1},content:{type:"doc",content:[
      ...(plain?[]:[{type:"heading",attrs:{level:1,blockId:"blk_heading"},content:[{type:"text",text:"Blueprint: 阅读和编辑的连续性"}]}]),
      ...Array.from({length:35},(_,i)=>paragraph("第 "+i+" 段：保留阅读位置与编辑状态。 Comfortable reading keeps the document visible while metadata changes.","blk_paragraph_"+i)),
      {type:"codeBlock",attrs:{language:"text"},content:[{type:"text",text:"long_source_identifier_".repeat(40)}]},
      {type:"table",content:[{type:"tableRow",content:Array.from({length:8},()=>({type:"tableCell",content:[paragraph("Wide table content")] }))}]}
    ]}}
    const listeners=new Set(),writes=[],tabs=[],reads=[],requests=[],copies=[]
    export const [active,setActive]=createSignal(true)
    let holdWrites=false
    let created
    export const [parts,setParts]=createSignal([]),[slot,setSlot]=createSignal(null),[working,setWorking]=createSignal(false),[workflow,setWorkflow]=createSignal(undefined)
    let selection={features:["note","blueprint"]},owner=0,failWorkflow=false,holdWorkflow=false,releaseWorkflow=()=>{}
    const second={...note,id:"second",title:"Ordinary note",kind:"note",searchText:"Reference body"}
    const groups=[{scopeID:"home",scopeType:"home",notes:[note,second]},{scopeID:"project",scopeType:"project",notes:[{...second,id:"project-note",scopeID:"project"}]}]
    const emit=()=>listeners.forEach(fn=>fn({name:"home",details:{type:"note.updated",properties:{scopeID:"home",note,meta:note,changed:["title"]}}}))
    const sdk={url:"http://fixture.test",capabilities:{has:id=>["note","blueprint"].includes(id),current:()=>selection},event:{listen:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)}},client:{workflow:{session:{set:async args=>{requests.push(args);if(holdWorkflow)await new Promise(resolve=>releaseWorkflow=resolve);if(failWorkflow)return {error:new Error("Workflow transition failed")};return {data:{}}}}},note:{create:async args=>{requests.push(args);created={...second,id:"created",scopeID:args.scopeID,title:"New document"};return {data:created}},get:async({id})=>{reads.push(id);return {data:id==="created"?created:id==="second"?second:note}},listMeta:async()=>({data:groups}),update:async({notePatchInput})=>{writes.push(notePatchInput);if(holdWrites)return await new Promise(()=>{});note={...note,...notePatchInput,version:note.version+1};emit();return {data:note}}},blueprint:{loop:{list:async()=>({data:[]})}}}}
    export const useGlobalSDK=()=>sdk
    export const useSDK=()=>sdk
    const draft={current:parts,set:setParts,cursor:()=>0}
    export const usePrompt=()=>({...draft,capture:()=>{const captured=owner;return {draft,isCurrent:()=>captured===owner,release(){}}}})
    export const useGlobalSync=()=>({reconnectVersion:reconnect,data:{scope:[{id:"project",name:"Project",local:{directory:"/fixture/project"}}],provider:{all:[],connected:[]}}})
    export const useSync=()=>({data:{agent:[{name:"pico",mode:"primary",description:"Concise assistance"},{name:"forge",mode:"primary",description:"Coding tasks"}],config:{}}})
    export const useParams=()=>({dir:"aG9tZQ",get id(){return owner?"session-"+owner:"session"}})
    export const usePlatform=()=>({platform:"web"})
    export const useLocale=()=>{const {i18n}=useLingui();return {i18n:i18n(),fmt:{relative:()=>"Today",dateTime:()=>"Today"}}}
    export const tab={id:"reading-tab",panelId:"notes",resourceId:"reading",source:"home",title:note.title,state:{kind:note.kind}}
    const reference=new URLSearchParams(location.search).get("reference")
    const [live,setLive]=createStore({tabs:[{...tab,state:{...(reference?{referenceNavigation:"initial",referenceLocation:{kind:"heading",id:reference}}:{})}}]})
    export const useWorkbenchPanels=()=>({sessionKey:()=>"session",surface:()=>({tabs:()=>live.tabs,active:()=>tab.id,opened:()=>true}),updateTab:(id,patch)=>{tabs.push(patch);setLive("tabs",0,patch)},beforeClose:()=>()=>{}})
    window.fixture={writes,tabs,copies,reads,requests,parts,slot,setWorking,setWorkflow,resetRequests:()=>requests.length=0,setWorkflowFailure:v=>failWorkflow=v,holdWorkflow:()=>holdWorkflow=true,continueWorkflow:()=>holdWorkflow=false,releaseWorkflow:()=>releaseWorkflow(),changeOwner:()=>owner++,changeCapabilities:()=>selection={...selection},note:()=>note,emit,listenerCount:()=>listeners.size,setActive,reconnect:()=>setReconnect(v=>v+1),holdWrites:()=>{holdWrites=true},state:()=>live.tabs[0].state,navigate(blockId,sequence){setLive("tabs",0,"state",{referenceLocation:blockId?{kind:"heading",id:blockId}:undefined,referenceNavigation:sequence})},copy:text=>{copies.push(text);return true},setLoop(status){
      const loop={id:"loop",noteID:note.id,sessionID:"execution",scopeID:"home",source:"user",title:note.title,auditAgent:"supervisor",status,time:{created:1,updated:Date.now()}}
      listeners.forEach(fn=>fn({name:"home",details:{type:"blueprint_loop.updated",properties:{loop}}}))
    }}
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {Suspense} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {DataProvider} from "@ericsanchezok/synergy-ui/context"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {configureClipboard} from "@ericsanchezok/synergy-ui/clipboard"
    import {ViewActivityProvider} from ${JSON.stringify(path.join(source, "context/view-residency.tsx"))}
    import {NotePanel} from ${JSON.stringify(path.join(source, "components/note/panel.tsx"))}
    import {NoteDocumentsProvider,useNoteDocuments} from ${JSON.stringify(path.join(source, "components/note/documents.tsx"))}
    import {tab,parts,slot,setSlot,working,workflow,active} from "./services"
    import {usePromptAttachments} from ${JSON.stringify(path.join(source, "components/prompt-input/attachments-hook.ts"))}
    import {createPendingAttachmentTracker} from ${JSON.stringify(path.join(source, "components/prompt-input/pending-attachments.ts"))}
    import {LoopStatusEntry} from ${JSON.stringify(path.join(source, "components/prompt-input/loop-status-entry.tsx"))}
    import {resolveLoopDisplay} from ${JSON.stringify(path.join(source, "components/prompt-input/loop-status.ts"))}
    import {PromptAttachments} from ${JSON.stringify(path.join(source, "components/prompt-input/attachments.tsx"))}
    import {Show} from "solid-js"
    import ${JSON.stringify(path.join(source, "index.css"))}
    configureClipboard({writer:text=>window.fixture.copy(text)})
    function Content(){const docs=useNoteDocuments();window.fixture.controller=()=>docs.peek("home","reading");const list=new URLSearchParams(location.search).has("list");docs.navigation("home").setOpen(list);const api=usePromptAttachments({editor:()=>undefined,noteAttachments:()=>parts().filter(p=>p.type==="note"),sessionAttachments:()=>[],localArmedLoop:slot,setLocalArmedLoop:setSlot,activeLoopID:()=>undefined,working,workflowKind:workflow,clearPendingWorkflows:()=>window.fixture.requests.push("clear"),setStore(){},pendingUploads:createPendingAttachmentTracker()});
    return <ViewActivityProvider active={active}><Suspense fallback={<p>Loading</p>}><div style={list?"height:calc(100dvh - 110px)":"height:100%"}><NotePanel tab={list?undefined:tab}/></div><Show when={list}><div id="composer-drop" style="height:110px;border-top:1px solid var(--border-base)" onDragOver={api.handleDragOver} onDrop={api.handleDrop}>
      <Show when={slot()}><LoopStatusEntry value={resolveLoopDisplay({localBlueprint:slot(),status:{type:"idle"}})} onRemove={()=>setSlot(null)}/></Show>
      <PromptAttachments uploads={()=>[]} notes={()=>parts().filter(p=>p.type==="note")} sessions={()=>[]} pending={()=>[]} order={()=>parts().map(p=>p.id)} pendingFile={()=>undefined} retryAttachment={async()=>{}} serverUrl="http://fixture.test" removeAttachment={()=>{}}/>
      <span>Drop into composer</span>
    </div></Show></Suspense></ViewActivityProvider>}
    render(()=><ThemeProvider><I18nProvider i18n={setupI18n({locale:"en",messages:{en:{}}})}><DataProvider data={{}} directory={null} serverUrl="http://fixture.test"><DialogProvider><NoteDocumentsProvider><main style="height:100dvh;overflow:hidden"><Content/></main></NoteDocumentsProvider></DialogProvider></DataProvider></I18nProvider></ThemeProvider>,document.getElementById("root"))
  `,
  )
  const services = path.join(directory, "services.ts")
  const options = {
    configFile: false,
    logLevel: "error",
    root: directory,
    worker: { format: "es" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: {
      alias: [
        ...[
          "global-sdk",
          "global-sync",
          "sync",
          "session-route",
          "platform",
          "locale",
          "workbench",
          "sdk",
          "prompt",
        ].map((name) => ({
          find: `@/context/${name}`,
          replacement: services,
        })),
        {
          find: "@ericsanchezok/synergy-ui/context/marked",
          replacement: path.resolve(source, "../../../packages/ui/src/context/highlight-theme.ts"),
        },
        { find: "@", replacement: source },
      ],
    },
    build: {
      outDir: path.join(directory, "dist"),
      minify: false,
      reportCompressedSize: false,
      target: "esnext",
      lib: { entry: path.join(directory, "main.tsx"), formats: ["es"], fileName: "main", cssFileName: "styles" },
    },
  }
  const builder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {build} from ${JSON.stringify(Bun.resolveSync("vite", import.meta.dir))};import solid from ${JSON.stringify(Bun.resolveSync("vite-plugin-solid", import.meta.dir))};import tailwind from ${JSON.stringify(Bun.resolveSync("@tailwindcss/vite", import.meta.dir))};await build({...${JSON.stringify(options)},plugins:[solid(),tailwind()]});process.exit(0)`,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "inherit", stderr: "inherit" },
  )
  if (await builder.exited) throw new Error("Note reading fixture build failed")
  await Bun.write(
    path.join(directory, "dist/index.html"),
    '<!doctype html><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/main.js"></script>',
  )
  server = await preview({
    configFile: false,
    root: directory,
    preview: { host: "127.0.0.1", port: await fixturePort() },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(8000)
  await page.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  page.on("pageerror", (error) => errors.push(error.message))
}, 90_000)

afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

afterEach(async () => {
  await page?.clock.resume()
})

async function open(query = "") {
  errors.length = 0
  await page.goto(server.resolvedUrls!.local[0]! + query)
  await page.locator(".tiptap").waitFor()
}

test("notes show only their authored document heading while the name remains editable in options", async () => {
  await page.setViewportSize({ width: 1100, height: 800 })
  for (const query of ["", "?plain"]) {
    await open(query)
    expect(await page.getByRole("textbox", { name: "Note title" }).isVisible()).toBe(false)
    expect(await page.locator(".tiptap h1").count()).toBe(query ? 0 : 1)
    await page.evaluate(() => {
      const root = document.querySelector(".tiptap")!
      root.setAttribute("data-retained", "yes")
      root.parentElement!.scrollTop = 360
    })
    const scroll = await page.locator(".tiptap").evaluate((el) => el.parentElement!.scrollTop)
    await page.getByRole("button", { name: "Note options" }).click()
    expect(await page.getByRole("dialog", { name: "Note options" }).isVisible()).toBe(true)
    const name = page.getByRole("textbox", { name: "Note title" })
    await name.fill("Renamed note")
    await page.waitForFunction(
      () => (window as unknown as { fixture: { writes: unknown[] } }).fixture.writes.length === 1,
    )
    expect(await page.evaluate(() => (window as unknown as { fixture: { writes: unknown[] } }).fixture.writes)).toEqual(
      [{ title: "Renamed note", expectedVersion: 1 }],
    )
    await page.keyboard.press("Escape")
    await name.waitFor({ state: "hidden" })
    expect(await name.isVisible()).toBe(false)
    expect(await page.locator(".tiptap").getAttribute("data-retained")).toBe("yes")
    expect(await page.locator(".tiptap").evaluate((el) => el.parentElement!.scrollTop)).toBeCloseTo(scroll, 0)
    expect(await page.locator(".tiptap").textContent()).toContain("保留阅读位置")
    expect(errors).toEqual([])
  }
})

test("the reading column expands in a large panel and retains the editor across resize and theme changes", async () => {
  await open()
  await page.locator(".tiptap").evaluate((el) => el.setAttribute("data-retained", "yes"))
  await page.locator(".tiptap p").first().click()
  await page.keyboard.press("End")
  await page.keyboard.insertText(" retained draft")
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [375, 900, 1728, 2560]) {
      await page.setViewportSize({ width, height: 900 })
      const geometry = await page.locator(".tiptap").evaluate((el) => {
        const bounds = el.getBoundingClientRect(),
          host = el.parentElement!.getBoundingClientRect()
        const paragraph = el.querySelector("p")!,
          style = getComputedStyle(paragraph)
        return {
          width: bounds.width,
          left: bounds.left - host.left,
          right: host.right - bounds.right,
          font: parseFloat(style.fontSize),
          line: parseFloat(style.lineHeight),
          overflow: document.documentElement.scrollWidth > innerWidth,
          canvasOverflow: el.parentElement!.scrollWidth > el.parentElement!.clientWidth,
          headingTop: el.querySelector("h1")!.getBoundingClientRect().top - host.top,
        }
      })
      expect(geometry.overflow).toBe(false)
      expect(geometry.canvasOverflow).toBe(false)
      expect(geometry.left).toBeGreaterThanOrEqual(15)
      expect(Math.abs(geometry.left - geometry.right)).toBeLessThan(2)
      if (width >= 1728) {
        expect(geometry.width).toBeGreaterThanOrEqual(900)
        expect(geometry.width).toBeLessThanOrEqual(1000)
        expect(geometry.font).toBeGreaterThanOrEqual(18)
      }
      expect(geometry.line / geometry.font).toBeGreaterThanOrEqual(1.59)
      expect(geometry.headingTop).toBeLessThan(60)
      expect(await page.locator(".tiptap").getAttribute("data-retained")).toBe("yes")
    }
  }
  expect(await page.locator(".tiptap").textContent()).toContain(" retained draft")
  await page.keyboard.press("ControlOrMeta+z")
  expect(await page.locator(".tiptap").textContent()).not.toContain(" retained draft")
  expect(errors).toEqual([])
})

test("Blueprint notes retain the reviewed result and session link after the active run ends", async () => {
  await page.setViewportSize({ width: 375, height: 800 })
  await open()
  const editor = await page.locator(".tiptap").elementHandle()
  for (const [status, label] of [
    ["running", "Running"],
    ["auditing", "In review"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["completed", "Review passed"],
  ]) {
    await page.evaluate(
      (status) => (window as unknown as { fixture: { setLoop(status: string): void } }).fixture.setLoop(status),
      status,
    )
    await page.locator(".note-blueprint-state").filter({ hasText: label }).waitFor()
    expect(await page.locator(".note-blueprint-session-link").isVisible()).toBe(true)
    expect(await page.getByRole("button", { name: "Run", exact: true }).isDisabled()).toBe(
      ["running", "auditing"].includes(status!),
    )
    expect(await page.locator(".tiptap").evaluate((node, old) => node === old, editor)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  expect(errors).toEqual([])
})

test("Notes opens a bounded navigator beside the reader at wide widths and keeps a single create action", async () => {
  for (const width of [900, 1728, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(server.resolvedUrls!.local[0]! + "?list")
    await page.getByRole("button", { name: /^Ordinary note/ }).waitFor()
    const navigation = page.locator("[data-workspace-navigation]")
    expect(await navigation.count()).toBe(1)
    const bounds = await navigation.boundingBox()
    expect(bounds!.width).toBeLessThanOrEqual(420)
    expect(await page.getByRole("button", { name: "New note", exact: true }).count()).toBe(1)
    expect(await navigation.getByText("Blueprint", { exact: true }).count()).toBe(0)
    expect(await navigation.getByRole("button", { name: "Open in new tab" }).count()).toBe(0)
    await page.getByRole("button", { name: /^Ordinary note/ }).click()
    await page.locator(".tiptap").waitFor()
    await page.getByRole("searchbox", { name: "Search notes" }).fill("missing note")
    expect(await page.locator(".tiptap").isVisible()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  expect(errors).toEqual([])
})

test("Blueprint agent selection uses one heading and the available menu width", async () => {
  await page.setViewportSize({ width: 375, height: 720 })
  await open()
  await page.getByRole("button", { name: "Run", exact: true }).click()
  await page.getByRole("button", { name: /Current session/ }).click()
  const menu = page.locator(".note-run-menu")
  expect(await menu.getByText("Execution agent", { exact: true }).count()).toBe(0)
  expect(await menu.getByText("Choose which agent will execute this Blueprint.", { exact: true }).count()).toBe(0)
  const row = menu.locator('[data-slot="list-item"]').first()
  await row.waitFor()
  const geometry = await row.evaluate((el) => {
    const menu = el.closest(".note-run-menu")!.getBoundingClientRect()
    const row = el.getBoundingClientRect()
    return { left: row.left - menu.left, right: menu.right - row.right }
  })
  expect(geometry.left).toBeLessThanOrEqual(16)
  expect(geometry.right).toBeLessThanOrEqual(16)
  await page.getByRole("textbox", { name: /Search agents/ }).fill("forge")
  await menu.getByText("Forge", { exact: true }).click()
  expect(await menu.getByRole("button", { name: /Run/ }).isEnabled()).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test("native drags attach Notes and stage Blueprints after replacing idle workflows without starting execution", async () => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto(server.resolvedUrls!.local[0]! + "?list")
  const target = page.locator("#composer-drop")
  const note = page.getByRole("button", { name: /^Ordinary note/ })
  await note.dragTo(target)
  await target.getByText("Ordinary note", { exact: true }).waitFor()
  await note.dragTo(target)
  const fixture = () =>
    page.evaluate(() => {
      const data = (window as unknown as { fixture: { parts(): unknown[]; slot(): unknown; requests: unknown[] } })
        .fixture
      return { parts: data.parts(), slot: data.slot(), requests: data.requests }
    })
  expect((await fixture()).parts).toHaveLength(1)
  for (const [working, workflow] of [
    [false, "plan"],
    [false, "lightloop"],
    [true, undefined],
  ] as const) {
    await page.evaluate(
      ({ working, workflow }) => {
        const data = (
          window as unknown as {
            fixture: { setWorking(v: boolean): void; setWorkflow(v?: string): void; resetRequests(): void }
          }
        ).fixture
        data.resetRequests()
        data.setWorking(working)
        data.setWorkflow(workflow)
      },
      { working, workflow },
    )
    await page.getByRole("button", { name: "Blueprint: 阅读和编辑的连续性", exact: true }).dragTo(target)
    await target.locator('[data-component="loop-status-entry"]').waitFor()
    const state = await fixture()
    expect(state.slot).toMatchObject({ type: "pending", noteID: "reading", title: "Blueprint: 阅读和编辑的连续性" })
    expect(state.requests).toEqual(workflow ? [{ id: "session", workflowSetInput: { kind: "none" } }, "clear"] : [])
    expect(await target.getByText("Ready to run", { exact: true }).isVisible()).toBe(true)
    await target.getByRole("button", { name: "Cancel loop", exact: true }).click()
    expect((await fixture()).slot).toBeNull()
    expect((await fixture()).requests).toEqual(state.requests)
  }
  expect(errors).toEqual([])
})

test("the single new-note action selects a destination and narrow navigation restores keyboard focus", async () => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto(server.resolvedUrls!.local[0]! + "?list")
  await page.getByRole("button", { name: /^Ordinary note/ }).waitFor()
  expect(await page.locator("[data-workspace-navigation]").isVisible()).toBe(true)
  await page.getByRole("button", { name: "New note", exact: true }).click()
  await page.getByRole("menuitem", { name: "Project", exact: true }).click()
  await page.locator(".tiptap").waitFor()
  expect(
    await page.evaluate(() => (window as unknown as { fixture: { requests: unknown[] } }).fixture.requests),
  ).toEqual([{ scopeID: "project", noteCreateInput: { title: "" } }])
  expect(await page.locator("[data-workspace-navigation]").count()).toBe(0)
  const toggle = page.locator(".note-workspace-toolbar button[aria-controls]")
  await toggle.click()
  const drawer = page.getByRole("dialog", { name: "Notes", exact: true })
  await drawer.waitFor()
  expect(await drawer.getByRole("searchbox", { name: "Search notes" }).isVisible()).toBe(true)
  await page.keyboard.press("Escape")
  await drawer.waitFor({ state: "hidden" })
  await page.waitForFunction(() => document.activeElement?.matches(".note-workspace-toolbar button[aria-controls]"))
  expect(await toggle.evaluate((el) => el === document.activeElement)).toBe(true)
  expect(await page.locator(".tiptap").isVisible()).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test("Blueprint staging preserves busy workflows and failed or stale transitions cannot attach", async () => {
  await page.setViewportSize({ width: 1000, height: 800 })
  for (const mode of ["busy-plan", "busy-lightloop", "failure", "owner", "capabilities", "concurrent", "new-owner"]) {
    await page.goto(server.resolvedUrls!.local[0]! + "?list")
    await page.evaluate((mode) => {
      const data = (
        window as unknown as {
          fixture: {
            setWorkflow(v: string): void
            setWorking(v: boolean): void
            setWorkflowFailure(v: boolean): void
            holdWorkflow(): void
          }
        }
      ).fixture
      data.setWorkflow(mode === "busy-lightloop" ? "lightloop" : "plan")
      data.setWorking(mode.startsWith("busy"))
      data.setWorkflowFailure(mode === "failure")
      if (["owner", "capabilities", "concurrent", "new-owner"].includes(mode)) data.holdWorkflow()
    }, mode)
    const blueprint = page.getByRole("button", { name: "Blueprint: 阅读和编辑的连续性", exact: true })
    const target = page.locator("#composer-drop")
    await blueprint.dragTo(target)
    if (["owner", "capabilities", "concurrent", "new-owner"].includes(mode)) {
      await page.waitForFunction(
        () => (window as unknown as { fixture: { requests: unknown[] } }).fixture.requests.length === 1,
      )
      if (mode === "concurrent") await blueprint.dragTo(target)
      if (mode === "new-owner") {
        await page.evaluate(() => {
          const data = (window as unknown as { fixture: { changeOwner(): void; continueWorkflow(): void } }).fixture
          data.changeOwner()
          data.continueWorkflow()
        })
        await blueprint.dragTo(target)
        expect(await target.getByText("Ready to run", { exact: true }).isVisible()).toBe(true)
      }

      await page.evaluate((mode) => {
        const data = (
          window as unknown as { fixture: { changeOwner(): void; changeCapabilities(): void; releaseWorkflow(): void } }
        ).fixture
        if (mode === "owner") data.changeOwner()
        if (mode === "capabilities") data.changeCapabilities()
        data.releaseWorkflow()
      }, mode)
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const state = await page.evaluate(() => {
      const data = (window as unknown as { fixture: { slot(): unknown; requests: unknown[] } }).fixture
      return { slot: data.slot(), requests: data.requests }
    })
    expect(state.requests).toEqual(
      mode.startsWith("busy")
        ? []
        : mode === "new-owner"
          ? [
              { id: "session", workflowSetInput: { kind: "none" } },
              { id: "session-1", workflowSetInput: { kind: "none" } },
              "clear",
            ]
          : mode === "concurrent"
            ? [{ id: "session", workflowSetInput: { kind: "none" } }, "clear"]
            : [{ id: "session", workflowSetInput: { kind: "none" } }],
    )
    if (mode === "concurrent" || mode === "new-owner")
      expect(state.slot).toMatchObject({ type: "pending", noteID: "reading" })
    else expect(state.slot).toBeNull()
  }
  expect(errors).toEqual([])
})

test("initial reference navigation reads the latest Workbench tab and keeps its request through kind hydration", async () => {
  await page.setViewportSize({ width: 1100, height: 800 })
  await open("?reference=blk_paragraph_25")
  await page.waitForFunction(() => document.querySelector('[data-slot="document-scroll"]')!.scrollTop > 500)
  const state = await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.state())
  expect(state).toMatchObject({ kind: "blueprint" })
  expect(state.referenceNavigation).toBeUndefined()
  expect(state.referenceLocation).toBeUndefined()
  expect(await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.writes)).toEqual([])
  expect(errors).toEqual([])
})

test("stable block requests scroll once only when active without changing a dirty document, selection or editor", async () => {
  await open()
  await page.evaluate(() => document.fonts.ready)
  await page.locator("pre.shiki").waitFor()
  const root = await page.locator(".tiptap").elementHandle()
  await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.holdWrites())
  await page.evaluate(() => {
    const editor = (window as unknown as { fixture: ReadingFixture }).fixture.controller().view.editor!
    editor.commands.insertContentAt(3, " unsaved reference draft")
    editor.view.focus()
  })
  await page.evaluate(() =>
    (window as unknown as { fixture: ReadingFixture }).fixture
      .controller()
      .view.editor!.commands.setTextSelection({ from: 2, to: 8 }),
  )
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const retained = await page.evaluateHandle(() => {
    const controller = (window as unknown as { fixture: ReadingFixture }).fixture.controller()
    const editor = controller.view.editor!
    const scrolls: string[] = []
    const originalScroll = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (...args) {
      scrolls.push(this.getAttribute("data-block-id") ?? "")
      return originalScroll.apply(this, args)
    }
    const transactions: Array<{ changed: boolean; selection: boolean; scroll: boolean }> = []
    editor.on("transaction", ({ transaction }) =>
      transactions.push({
        changed: transaction.docChanged,
        selection: transaction.selectionSet,
        scroll: transaction.scrolledIntoView,
      }),
    )
    return {
      editor,
      view: editor.view,
      doc: editor.state.doc,
      selection: editor.state.selection,
      dirty: controller.dirty(),
      json: editor.getJSON(),
      transactions,
      scrolls,
    }
  })
  const selected = await page.evaluate(() => window.getSelection()!.toString())
  await page.evaluate(() =>
    (window as unknown as { fixture: ReadingFixture }).fixture.navigate("blk_paragraph_25", "first"),
  )
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction(() => document.querySelector('[data-slot="document-scroll"]')!.scrollTop > 500)
  expect(await page.locator(".tiptap").evaluate((node, previous) => node === previous, root)).toBe(true)
  expect(
    await page.evaluate((previous) => {
      const controller = (window as unknown as { fixture: ReadingFixture }).fixture.controller()
      const editor = controller.view.editor!
      return {
        editor: editor === previous.editor,
        view: editor.view === previous.view,
        doc: editor.state.doc === previous.doc,
        selection: editor.state.selection.eq(previous.selection),
        dirty: controller.dirty(),
        json: editor.getJSON(),
      }
    }, retained),
  ).toMatchObject({ editor: true, view: true, doc: true, selection: true })
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected)
  expect(
    await page.evaluate((previous) => {
      const controller = (window as unknown as { fixture: ReadingFixture }).fixture.controller()
      return (
        JSON.stringify(controller.content()) === JSON.stringify(previous.json) &&
        JSON.stringify(controller.dirty()) === JSON.stringify(previous.dirty)
      )
    }, retained),
  ).toBe(true)
  expect(
    await page.evaluate(
      (previous) =>
        previous.transactions.filter(
          (transaction) => transaction.changed || transaction.selection || transaction.scroll,
        ),
      retained,
    ),
  ).toEqual([])

  await page.locator('[data-slot="document-scroll"]').evaluate((element) => {
    element.scrollTo({ top: 0, behavior: "instant" })
  })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction(() => document.querySelector('[data-slot="document-scroll"]')!.scrollTop === 0)
  expect(
    await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.state().referenceNavigation),
  ).toBeUndefined()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await page.locator('[data-slot="document-scroll"]').evaluate((element) => element.scrollTop)).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.setActive(false))
  await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.setActive(true))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(
    await page.evaluate(
      (previous) => ({
        scroll: document.querySelector('[data-slot="document-scroll"]')!.scrollTop,
        editor: (window as unknown as { fixture: ReadingFixture }).fixture.controller().view.editor === previous.editor,
        doc:
          (window as unknown as { fixture: ReadingFixture }).fixture.controller().view.editor!.state.doc ===
          previous.doc,
        scrolls: previous.scrolls,
      }),
      retained,
    ),
  ).toMatchObject({ scroll: 0, editor: true, doc: true, scrolls: ["blk_paragraph_25"] })
  await page.evaluate(() => {
    const fixture = (window as unknown as { fixture: ReadingFixture }).fixture
    fixture.setActive(false)
    fixture.navigate("blk_paragraph_25", "second")
  })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await page.locator('[data-slot="document-scroll"]').evaluate((element) => element.scrollTop)).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.state())).toMatchObject({
    referenceNavigation: "second",
  })
  await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.setActive(true))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction(() => document.querySelector('[data-slot="document-scroll"]')!.scrollTop > 500)
  expect(
    await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.state().referenceNavigation),
  ).toBeUndefined()
  await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.navigate("blk_deleted", "third"))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.getByRole("status").filter({ hasText: "This location is no longer available in this note." }).waitFor()
  expect(await page.locator(".tiptap").textContent()).toContain("unsaved reference draft")
  const previousScroll = await page.locator('[data-slot="document-scroll"]').evaluate((element) => element.scrollTop)
  await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.navigate(undefined, "fourth"))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.getByText("This location is no longer available in this note.").waitFor({ state: "hidden" })
  expect(await page.locator('[data-slot="document-scroll"]').evaluate((element) => element.scrollTop)).toBe(
    previousScroll,
  )
  expect(errors).toEqual([])
})

test("Copy reference uses the document or selected stable block without inventing a heading slug", async () => {
  await open()
  await page.getByRole("button", { name: "Copy reference", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.copies)).toEqual([
    "note://reading",
  ])
  await page.evaluate(() => {
    const editor = (window as unknown as { fixture: ReadingFixture }).fixture.controller().view.editor!
    let target = 0
    editor.state.doc.descendants((node, position) => {
      if (node.attrs.blockId === "blk_paragraph_12") target = position + 1
    })
    editor.commands.setTextSelection({ from: target, to: target + 8 })
    editor.commands.focus()
  })
  await page.getByRole("button", { name: "Copy reference", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.copies)).toEqual([
    "note://reading",
    "note://reading#blk_paragraph_12",
  ])
  expect(await page.evaluate(() => (window as unknown as { fixture: ReadingFixture }).fixture.writes)).toEqual([])
  expect(errors).toEqual([])
})

test("hidden notes defer reconnect reads and preserve the editor when reactivated", async () => {
  await open("?plain")
  const editor = await page.locator(".tiptap").elementHandle()
  const reads = await page.evaluate(() => {
    const fixture = (
      window as unknown as { fixture: { setActive(value: boolean): void; reconnect(): void; reads: unknown[] } }
    ).fixture
    fixture.setActive(false)
    fixture.reconnect()
    return fixture.reads.length
  })
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => (window as unknown as { fixture: { reads: unknown[] } }).fixture.reads.length)).toBe(
    reads,
  )
  await page.evaluate(() =>
    (window as unknown as { fixture: { setActive(value: boolean): void } }).fixture.setActive(true),
  )
  await page.waitForFunction(
    (count) => (window as unknown as { fixture: { reads: unknown[] } }).fixture.reads.length > count,
    reads,
  )
  await page.locator(".tiptap").waitFor()
  expect(await page.locator(".tiptap").evaluate((node, previous) => node === previous, editor)).toBe(true)
  expect(errors).toEqual([])
})

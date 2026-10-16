import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { preview, type PreviewServer } from "vite"

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
    const plain=new URLSearchParams(location.search).has("plain")
    const paragraph=text=>({type:"paragraph",content:[{type:"text",text}]})
    let note={id:"reading",scopeID:"home",title:"Blueprint: 阅读和编辑的连续性",kind:plain?"note":"blueprint",version:1,tags:["reading"],pinned:false,global:false,archived:false,time:{created:1,updated:1},content:{type:"doc",content:[
      ...(plain?[]:[{type:"heading",attrs:{level:1},content:[{type:"text",text:"Blueprint: 阅读和编辑的连续性"}]}]),
      ...Array.from({length:35},(_,i)=>paragraph("第 "+i+" 段：保留阅读位置与编辑状态。 Comfortable reading keeps the document visible while metadata changes.")),
      {type:"codeBlock",attrs:{language:"text"},content:[{type:"text",text:"long_source_identifier_".repeat(40)}]},
      {type:"table",content:[{type:"tableRow",content:Array.from({length:8},()=>({type:"tableCell",content:[paragraph("Wide table content")] }))}]}
    ]}}
    const listeners=new Set(),writes=[],tabs=[],reads=[],requests=[]
    let created
    export const [parts,setParts]=createSignal([]),[slot,setSlot]=createSignal(null),[working,setWorking]=createSignal(false),[workflow,setWorkflow]=createSignal(undefined)
    let selection={features:["note","blueprint"]},owner=0,failWorkflow=false,holdWorkflow=false,releaseWorkflow=()=>{}
    const second={...note,id:"second",title:"Ordinary note",kind:"note",searchText:"Reference body"}
    const groups=[{scopeID:"home",scopeType:"home",notes:[note,second]},{scopeID:"project",scopeType:"project",notes:[{...second,id:"project-note",scopeID:"project"}]}]
    const emit=()=>listeners.forEach(fn=>fn({name:"home",details:{type:"note.updated",properties:{scopeID:"home",note,meta:note,changed:["title"]}}}))
    const sdk={url:"http://fixture.test",capabilities:{has:id=>["note","blueprint"].includes(id),current:()=>selection},event:{listen:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)}},client:{workflow:{session:{set:async args=>{requests.push(args);if(holdWorkflow)await new Promise(resolve=>releaseWorkflow=resolve);if(failWorkflow)return {error:new Error("Workflow transition failed")};return {data:{}}}}},note:{create:async args=>{requests.push(args);created={...second,id:"created",scopeID:args.scopeID,title:"New document"};return {data:created}},get:async({id})=>{reads.push(id);return {data:id==="created"?created:id==="second"?second:note}},listMeta:async()=>({data:groups}),update:async({notePatchInput})=>{writes.push(notePatchInput);note={...note,...notePatchInput,version:note.version+1};emit();return {data:note}}},blueprint:{loop:{list:async()=>({data:[]})}}}}
    export const useGlobalSDK=()=>sdk
    export const useSDK=()=>sdk
    const draft={current:parts,set:setParts,cursor:()=>0}
    export const usePrompt=()=>({...draft,capture:()=>{const captured=owner;return {draft,isCurrent:()=>captured===owner,release(){}}}})
    export const useGlobalSync=()=>({reconnectVersion:()=>0,data:{scope:[{id:"project",name:"Project",local:{directory:"/fixture/project"}}],provider:{all:[],connected:[]}}})
    export const useSync=()=>({data:{agent:[{name:"pico",mode:"primary",description:"Concise assistance"},{name:"forge",mode:"primary",description:"Coding tasks"}],config:{}}})
    export const useParams=()=>({dir:"aG9tZQ",get id(){return owner?"session-"+owner:"session"}})
    export const usePlatform=()=>({platform:"web"})
    export const useLocale=()=>{const {i18n}=useLingui();return {i18n:i18n(),fmt:{relative:()=>"Today",dateTime:()=>"Today"}}}
    export const tab={id:"reading-tab",panelId:"notes",resourceId:"reading",source:"home",title:note.title,state:{kind:note.kind}}
    export const useWorkbenchPanels=()=>({sessionKey:()=>"session",surface:()=>({tabs:()=>[tab]}),updateTab:(id,patch)=>tabs.push(patch),beforeClose:()=>()=>{}})
    window.fixture={writes,tabs,reads,requests,parts,slot,setWorking,setWorkflow,resetRequests:()=>requests.length=0,setWorkflowFailure:v=>failWorkflow=v,holdWorkflow:()=>holdWorkflow=true,continueWorkflow:()=>holdWorkflow=false,releaseWorkflow:()=>releaseWorkflow(),changeOwner:()=>owner++,changeCapabilities:()=>selection={...selection},note:()=>note,emit,listenerCount:()=>listeners.size,setLoop(status){
      const loop={id:"loop",noteID:note.id,sessionID:"execution",scopeID:"home",source:"user",title:note.title,auditAgent:"supervisor",status,time:{created:1,updated:Date.now()}}
      listeners.forEach(fn=>fn({name:"home",details:{type:"blueprint_loop.updated",properties:{loop}}}))
    }}
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {DataProvider} from "@ericsanchezok/synergy-ui/context"
    import {ThemeProvider} from "@ericsanchezok/synergy-ui/theme"
    import {NotePanel} from ${JSON.stringify(path.join(source, "components/note/panel.tsx"))}
    import {NoteDocumentsProvider,useNoteDocuments} from ${JSON.stringify(path.join(source, "components/note/documents.tsx"))}
    import {tab,parts,slot,setSlot,working,workflow} from "./services"
    import {usePromptAttachments} from ${JSON.stringify(path.join(source, "components/prompt-input/attachments-hook.ts"))}
    import {createPendingAttachmentTracker} from ${JSON.stringify(path.join(source, "components/prompt-input/pending-attachments.ts"))}
    import {LoopStatusEntry} from ${JSON.stringify(path.join(source, "components/prompt-input/loop-status-entry.tsx"))}
    import {resolveLoopDisplay} from ${JSON.stringify(path.join(source, "components/prompt-input/loop-status.ts"))}
    import {PromptAttachments} from ${JSON.stringify(path.join(source, "components/prompt-input/attachments.tsx"))}
    import {Show} from "solid-js"
    import ${JSON.stringify(path.join(source, "index.css"))}
    function Content(){const docs=useNoteDocuments();const list=new URLSearchParams(location.search).has("list");docs.navigation("home").setOpen(list);const api=usePromptAttachments({editor:()=>undefined,noteAttachments:()=>parts().filter(p=>p.type==="note"),sessionAttachments:()=>[],localArmedLoop:slot,setLocalArmedLoop:setSlot,activeLoopID:()=>undefined,working,workflowKind:workflow,clearPendingWorkflows:()=>window.fixture.requests.push("clear"),setStore(){},pendingUploads:createPendingAttachmentTracker()});
    return <><div style={list?"height:calc(100dvh - 110px)":"height:100%"}><NotePanel tab={list?undefined:tab}/></div><Show when={list}><div id="composer-drop" style="height:110px;border-top:1px solid var(--border-base)" onDragOver={api.handleDragOver} onDrop={api.handleDrop}>
      <Show when={slot()}><LoopStatusEntry value={resolveLoopDisplay({localBlueprint:slot(),status:{type:"idle"}})} onRemove={()=>setSlot(null)}/></Show>
      <PromptAttachments uploads={()=>[]} notes={()=>parts().filter(p=>p.type==="note")} sessions={()=>[]} pending={()=>[]} order={()=>parts().map(p=>p.id)} pendingFile={()=>undefined} retryAttachment={async()=>{}} serverUrl="http://fixture.test" removeAttachment={()=>{}}/>
      <span>Drop into composer</span>
    </div></Show></>}
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
        { find: "@", replacement: source },
      ],
    },
    build: {
      outDir: path.join(directory, "dist"),
      minify: false,
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

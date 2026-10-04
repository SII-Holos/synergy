import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"
import { preview, type PreviewServer } from "vite"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

let directory: string
let server: PreviewServer
let browser: Browser
let page: Page
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "synergy-task-details-dom-"))
  const app = path.resolve(import.meta.dir, "../../..")
  const source = path.join(app, "src")
  await symlink(path.join(app, "node_modules"), path.join(directory, "node_modules"), "dir")
  await Bun.write(path.join(directory, "package.json"), '{"type":"module"}')
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import {createStore} from "solid-js/store"
    import {createGlobalEmitter} from "@solid-primitives/event-bus"
    import {createSessionDataView} from "@ericsanchezok/synergy-ui/context/session-data-view"
    import {useLingui} from "@lingui/solid"
    const token={known:1200,unknown:1,total:null}
    const zero={known:0,unknown:0,total:0}
    const accounting={calls:1,tokens:{input:token,output:zero,total:token},cost:{},billing:{},failures:0}
    const task=(i)=>({sessionID:"child-"+i,nodeID:"node-"+i,parentID:"root",title:"Delegated task "+i,status:"running",elapsedMs:1000,elapsedActive:true,tokens:token,runs:["run-"+i],cortex:{taskID:"ctx_"+i,agent:"forge",status:i===0?"queued":"running"}})
    const summary={sessionID:"root",revision:1,computedAt:Date.now(),status:"completed",elapsedMs:31000,elapsedActive:false,accounting,own:accounting,descendants:accounting,cost:{state:"recorded",reported:[],estimates:[],missing:0,equivalent:null},context:null,contextDistribution:null,tasks:[...Array.from({length:7},(_,i)=>task(i)),{...task(7),cortex:undefined,title:"Chronicler",interaction:{mode:"unattended",source:"chronicler"}}],coverage:{recorded:1,messages:0,gaps:1,partial:true},lanes:[],rounds:[]}
    const inbox=Array.from({length:7},(_,i)=>({id:"inbox-"+i,sessionID:"root",mode:i===2?"context":i===1?"steer":"task",status:i===3?"failed":"pending",orderKey:String(i),source:{type:"user",label:"User"},summary:{title:"Inbox message "+i,preview:"Inbox message "+i},detail:{text:"Full inbox message "+i},time:{created:1}}))
    const [data,setData]=createStore({inbox:{root:inbox},message:{root:[]},part:{},workspaces:[]})
    const session={id:"root",scope:{id:"project",type:"project",name:"synergy",local:{directory:"/project",vcs:"git"}},workspace:{id:"workspace",type:"git_worktree",path:"/project/.worktrees/task-details",bindingState:"bound"}}
    const items=Array.from({length:25},(_,i)=>({itemID:"agenda-"+i,title:"Scheduled task "+i,status:"active",nextRunAt:Date.now()+3600000,triggers:[{type:"every",interval:"1h"}],triggerTypes:["every"],global:false}))
    const event=createGlobalEmitter()
    const removed=[]
    const fullAgendaItem=(entry)=>({...entry,id:entry.itemID,origin:{scope:{id:"project",type:"project"},sessionID:"root"},time:{created:1,updated:1},state:{runCount:0,nextRunAt:entry.nextRunAt},createdBy:"user"})
    const sdk={scopeID:"project",event,client:{agenda:{get:async(q)=>{if(window.agendaResolveDelay)await new Promise(r=>setTimeout(r,window.agendaResolveDelay));return {data:fullAgendaItem(items.find(i=>i.itemID===q.id))}},runs:async()=>{if(window.agendaRunsDelay)await new Promise(r=>setTimeout(r,window.agendaRunsDelay));return {data:[]}},pause:async(q)=>{if(window.agendaPauseDelay)await new Promise(r=>setTimeout(r,window.agendaPauseDelay));items.find(i=>i.itemID===q.id).status="paused";return {data:true}},activate:async(q)=>{items.find(i=>i.itemID===q.id).status="active";return {data:true}}},worktree:{list:async()=>({data:[{path:session.workspace.path,branch:"codex/task-details"}]})},session:{agenda:async(q)=>{
      (window.agendaRequests ??=[]).push(q)
      if(window.agendaFail)throw new Error("Agenda unavailable")
      if(window.agendaDelay)await new Promise(r=>setTimeout(r,window.agendaDelay))
      const start=q.offset || 0
      return {data:{sessionID:q.sessionID,items:items.slice(start,start+q.limit),count:Math.min(q.limit,items.length-start),total:items.length,offset:start,limit:q.limit,hasMore:start+q.limit<items.length,hasActiveAgenda:true}}
    },inboxRemoved:async(q,options)=>{(window.removedRequests??=[]).push(options.signal);window.removedReads=(window.removedReads||0)+1;if(window.removedDelay)await new Promise(r=>setTimeout(r,window.removedDelay));return {data:removed}},inboxGuide:async(q)=>{window.guided=q.itemID},inboxRetry:async(q)=>{window.retried=q.itemID},inboxRemove:async(q)=>{const item=data.inbox.root.find(i=>i.id===q.itemID);removed.push(item);setData("inbox","root",data.inbox.root.filter(i=>i.id!==q.itemID));return {data:item}},inboxRestore:async(q)=>{const i=removed.findIndex(i=>i.id===q.itemID);setData("inbox","root",[...data.inbox.root,removed.splice(i,1)[0]]);return {data:true}}},cortex:{cancel:async(q)=>{window.cancelledTask=q.taskID;return {data:true}}}}}
    const [executionState,setExecutionState]=createStore({summary,error:undefined})
    export const useExecution=()=>({state:executionState,available:()=>!location.search.includes("minimal"),refresh:async()=>{window.refreshed=true},open:async(runID,nodeID)=>{window.openedNode=nodeID||"all"}})
    export const useParams=()=>({id:"root"})
    export const useSDK=()=>sdk
    export const useSync=()=>({data,session:{get:()=>session,refresh:async()=>{}}})
    export const useSessionDataView=()=>()=>createSessionDataView(data)
    export const useGlobalSDK=()=>({capabilities:{has:()=>true}})
    export const useLocale=()=>{const {i18n}=useLingui();return {i18n:i18n(),fmt:{time:(d)=>d.toLocaleTimeString(),dateTime:(d)=>d.toLocaleString()}}}
    export const useWorkbenchPanels=()=>({openPanel:async()=>{}})
    window.refreshAgenda=()=>event.emit("agenda.item.updated",{properties:{item:{origin:{sessionID:"root"}}}})
    window.failExecution=()=>setExecutionState({summary:undefined,error:"unavailable"})
    window.replaceClient=()=>sdk.client={...sdk.client}
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
    import {MarkedProvider} from "@ericsanchezok/synergy-ui/context/marked"
    import {Toast} from "@ericsanchezok/synergy-ui/toast"
    import {SessionTaskDetails} from ${JSON.stringify(`${source}/components/execution/session-task-details.tsx`)}
    import "@ericsanchezok/synergy-ui/styles"
    Object.defineProperty(navigator,"clipboard",{value:{writeText:async(text)=>{window.copiedPath=text}}})
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><MarkedProvider><Suspense fallback={<p>App loading</p>}><DialogProvider><main style="display:flex;justify-content:flex-end;padding:16px"><SessionTaskDetails hasCanonicalRoot/><Toast.Region/></main></DialogProvider></Suspense></MarkedProvider></I18nProvider>,document.getElementById("root"))
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
          "@solidjs/router",
          "@/context/sdk",
          "@/context/sync",
          "@/context/execution",
          "@/context/global-sdk",
          "@/context/session-data-view",
          "@/context/locale",
          "@/context/workbench",
        ].map((find) => ({ find, replacement: services })),
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
      `import {build} from ${JSON.stringify(Bun.resolveSync("vite", import.meta.dir))}; import solidPlugin from ${JSON.stringify(Bun.resolveSync("vite-plugin-solid", import.meta.dir))}; await build({...${JSON.stringify(options)},plugins:[solidPlugin()]}); process.exit(0)`,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "inherit", stderr: "inherit" },
  )
  if (await builder.exited) throw new Error("Task details fixture build failed")
  await Bun.write(
    path.join(directory, "dist/index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/main.js"></script>',
  )
  server = await preview({
    configFile: false,
    root: directory,
    preview: { host: "127.0.0.1", port: await fixturePort() },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 480, height: 900 } })
  page.setDefaultTimeout(5000)
  await page.emulateMedia({ reducedMotion: "reduce" })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
}, 120_000)

beforeEach(async () => {
  errors.length = 0
  await page.setViewportSize({ width: 480, height: 900 })
  await page.goto(server.resolvedUrls!.local[0]!)
  if (errors.length) throw new Error(errors.join("\n"))
  await page.getByRole("button", { name: "Task details", exact: true }).click()
  await page.locator(".execution-popover").waitFor()
}, 30_000)

afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("flat sections show inbox immediately and auxiliary tasks stay in the full trajectory", async () => {
  expect(await page.locator(".execution-compact-section h3").allTextContents()).toEqual([
    "Inbox",
    "Scheduled tasks",
    "Subtasks",
  ])
  expect(await page.locator(".execution-task-row").count()).toBe(7)
  expect(await page.locator(".execution-popover").getByText("Chronicler", { exact: true }).count()).toBe(0)
  expect(await page.evaluate(() => Reflect.get(window, "removedReads") || 0)).toBe(0)
  expect(
    await page
      .locator(".execution-popover")
      .getByText(/partial|incomplete|Connected|native/i)
      .count(),
  ).toBe(0)
  await page.getByRole("button", { name: "Copy workspace path", exact: true }).click()
  expect(await page.evaluate(() => Reflect.get(window, "copiedPath"))).toBe("/project/.worktrees/task-details")
  expect(errors).toEqual([])
})

test("row actions reveal on focus, keep title width stable and use canonical task cancellation", async () => {
  const row = page.locator(".execution-task-row").first()
  const title = row.locator(".execution-row-title")
  const width = (await title.boundingBox())!.width
  const cancel = row.getByRole("button", { name: "Cancel subtask", exact: true })
  expect(await cancel.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe("0")
  await row.locator(".execution-row-main").focus()
  expect(await cancel.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe("1")
  expect((await title.boundingBox())!.width).toBeCloseTo(width, 1)
  await cancel.click()
  expect(await page.evaluate(() => Reflect.get(window, "cancelledTask"))).toBe("ctx_0")
  expect(await row.getAttribute("data-state")).toBe("queued")
  expect(errors).toEqual([])
})

test("each list scrolls at four rows and agenda loads more while retaining data on refresh failure", async () => {
  for (const selector of [".execution-inbox-list", ".execution-agenda-list", ".execution-task-list"]) {
    const list = page.locator(selector)
    const sizes = await list.evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight }))
    expect(sizes.height).toBeLessThanOrEqual(160)
    expect(sizes.scroll).toBeGreaterThan(sizes.height)
  }
  await page.locator(".execution-agenda-list").evaluate((el) => {
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event("scroll"))
  })
  await page.waitForFunction(() => document.querySelectorAll(".execution-agenda-row").length === 25)
  await page.evaluate(() => {
    Reflect.set(window, "agendaFail", true)
    Reflect.get(window, "refreshAgenda")()
  })
  await page.getByRole("button", { name: "Could not load scheduled activity. Retry", exact: true }).waitFor()
  expect(await page.locator(".execution-agenda-row").count()).toBe(25)
  expect(errors).toEqual([])
})

for (const viewport of [
  { width: 375, height: 667 },
  { width: 320, height: 420 },
]) {
  test("header, list controls and fonts remain usable at " + viewport.width + "px", async () => {
    await page.setViewportSize(viewport)
    await page.waitForFunction(() => {
      const box = document.querySelector(".execution-popover")?.getBoundingClientRect()
      return box && box.right <= innerWidth - 8 && box.bottom <= innerHeight - 8
    })
    const surface = page.locator(".execution-popover")
    const box = await surface.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(8)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 8)
    expect(await surface.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(
      await page
        .locator(".execution-row-title")
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe("14px")
    await surface.locator('[data-slot="popover-close-button"]').click()
    await surface.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Task details")
    expect(
      await page
        .getByRole("button", { name: "Task details", exact: true })
        .evaluate((el) => document.activeElement === el),
    ).toBe(true)
    expect(errors).toEqual([])
  })
}

test("stats failure leaves independent resources and inbox usable", async () => {
  await page.evaluate(() => Reflect.get(window, "failExecution")())
  expect(await page.locator(".execution-inbox-row").count()).toBe(7)
  expect(await page.getByRole("button", { name: "Copy workspace path", exact: true }).count()).toBe(1)
  expect(await page.locator(".execution-agenda-row").count()).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test("focused row tooltips keep their viewport coordinates across narrow resizing", async () => {
  await page.locator(".execution-task-row .execution-row-main").first().focus()
  await page.locator('[data-component="tooltip"]').last().waitFor()
  await page.setViewportSize({ width: 375, height: 667 })
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  const tooltip = page.locator('[data-component="tooltip"]').last()
  const box = (await tooltip.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
  expect(box.y + box.height).toBeLessThanOrEqual(667)
  expect(errors).toEqual([])
})

test("a focused row tooltip cannot remain outside a shortened viewport", async () => {
  await page.locator(".execution-task-row .execution-row-main").first().focus()
  await page.locator('[data-component="tooltip"]').last().waitFor()
  await page.setViewportSize({ width: 320, height: 420 })
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  const tooltip = page.locator('[data-component="tooltip"]').last()
  if (await tooltip.isVisible()) {
    const box = (await tooltip.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(320)
    expect(box.y + box.height).toBeLessThanOrEqual(420)
  }
  expect(errors).toEqual([])
})

test("inbox detail keeps contextual messages read-only and removal has a recoverable history", async () => {
  const context = page.locator(".execution-inbox-row[data-mode='context']")
  expect(await context.locator(".execution-row-actions button").count()).toBe(0)
  const row = page.locator(".execution-inbox-row[data-mode='task']").first()
  await row.locator(".execution-row-main").click()
  await page.getByText("Full inbox message 0", { exact: true }).waitFor()
  await page.keyboard.press("Escape")
  await row.locator(".execution-row-main").focus()
  await row.getByRole("button", { name: "Remove message", exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll(".execution-inbox-row").length === 6)
  await page.getByRole("button", { name: "More details", exact: true }).focus()
  await page.getByRole("button", { name: "More details", exact: true }).click()
  await page.getByRole("button", { name: "Inbox history", exact: true }).click()
  await page.locator(".session-inbox-removed-item").waitFor()
  expect(await page.evaluate(() => Reflect.get(window, "removedReads"))).toBeGreaterThan(0)
  await page.locator(".session-inbox-removed-item").getByRole("button", { name: "Restore", exact: true }).click()
  await page.locator(".execution-inbox-back").click()
  await page.waitForFunction(() => document.querySelectorAll(".execution-inbox-row").length === 7)
  expect(errors).toEqual([])
})

test("scheduled task details stay visible during history loading and remain usable after the popover closes", async () => {
  await page.evaluate(() => {
    Reflect.set(window, "agendaRunsDelay", 1000)
    Reflect.set(window, "agendaPauseDelay", 500)
  })
  await page.locator(".execution-agenda-row .execution-row-main").first().click()
  const detail = page.getByRole("dialog").filter({ has: page.locator(".agenda-details") })
  await detail.waitFor({ timeout: 500 })
  expect(await page.getByText("App loading", { exact: true }).count()).toBe(0)
  await page.locator(".execution-popover").waitFor({ state: "hidden" })
  await detail.getByRole("button", { name: "Pause", exact: true }).click()
  await detail.getByRole("button", { name: "Enable", exact: true }).waitFor()
  expect(await detail.getByRole("button", { name: "Enable", exact: true }).isEnabled()).toBe(true)
  await detail.getByRole("button", { name: "Enable", exact: true }).click()
  await detail.getByRole("button", { name: "Pause", exact: true }).waitFor()
  expect(await detail.getByRole("button", { name: "Pause", exact: true }).isEnabled()).toBe(true)
  expect(errors).toEqual([])
})

test("a scheduled-task detail request cannot open a dialog after its client changes", async () => {
  await page.evaluate(() => Reflect.set(window, "agendaResolveDelay", 500))
  await page.locator(".execution-agenda-row .execution-row-main").first().click()
  await page.evaluate(() => Reflect.get(window, "replaceClient")())
  await page.waitForTimeout(700)
  expect(await page.locator(".agenda-detail-dialog").count()).toBe(0)
  expect(errors).toEqual([])
})

test("an inbox detail stays within the viewport when opened after narrow resizing", async () => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.locator(".execution-inbox-row .execution-row-main").first().click()
  const detail = page.locator(".session-inbox-row-tooltip")
  await detail.waitFor()
  const box = (await detail.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(8)
  expect(box.x + box.width).toBeLessThanOrEqual(367)
  expect(box.y + box.height).toBeLessThanOrEqual(659)
  await page.keyboard.press("Escape")
  expect(await page.locator(".execution-popover").isVisible()).toBe(true)
  expect(errors).toEqual([])
})

test("closing task details returns focus to the visible responsive toolbar trigger", async () => {
  await page.evaluate(() => {
    const header = document.querySelector("main")!
    header.classList.add("stb-root")
    const mobile = document.createElement("button")
    mobile.type = "button"
    mobile.className = "execution-trigger"
    mobile.setAttribute("data-responsive-trigger", "")
    mobile.textContent = "Mobile task details"
    header.append(mobile)
    document.querySelector<HTMLButtonElement>(".execution-trigger")!.style.display = "none"
  })
  await page.locator('[data-slot="popover-close-button"]').first().click()
  await page.locator(".execution-popover").waitFor({ state: "hidden" })
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  expect(await page.locator("[data-responsive-trigger]").evaluate((el) => document.activeElement === el)).toBe(true)
  expect(errors).toEqual([])
})

test("loading inbox history preserves the task surface and does not suspend the app", async () => {
  await page.evaluate(() => Reflect.set(window, "removedDelay", 1000))
  await page.getByRole("button", { name: "More details", exact: true }).focus()
  await page.getByRole("button", { name: "More details", exact: true }).click()
  await page.getByRole("button", { name: "Inbox history", exact: true }).click()
  expect(await page.locator(".execution-inbox-back").isVisible()).toBe(true)
  expect(await page.getByText("App loading", { exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
})

test("leaving inbox history or closing task details cancels pending history reads", async () => {
  await page.evaluate("window.removedDelay=1500")
  for (const close of [false, true]) {
    await page.locator(".execution-compact-identity").hover()
    await page.locator(".execution-identity-action").click()
    await page.getByRole("button", { name: "Inbox history", exact: true }).click()
    expect(await page.evaluate<boolean>("window.removedRequests.at(-1).aborted")).toBe(false)
    if (close) await page.locator('[data-slot="popover-close-button"]').click()
    else await page.locator(".execution-inbox-back").click()
    expect(await page.evaluate<boolean>("window.removedRequests.at(-1).aborted")).toBe(true)
    expect(await page.getByText("App loading", { exact: true }).count()).toBe(0)
  }
  expect(errors).toEqual([])
})

test("touch controls remain visible and each action has a 44px hit area", async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true })
  try {
    const touch = await context.newPage()
    await touch.emulateMedia({ reducedMotion: "reduce" })
    await touch.goto(server.resolvedUrls!.local[0]!)
    await touch.getByRole("button", { name: "Task details", exact: true }).tap()
    const row = touch.locator(".execution-inbox-row[data-mode='task']").first()
    expect(await row.locator(".execution-row-actions").evaluate((el) => getComputedStyle(el).opacity)).toBe("1")
    const remove = row.getByRole("button", { name: "Remove message", exact: true })
    const bounds = (await remove.boundingBox())!
    expect(bounds.width).toBeGreaterThanOrEqual(44)
    expect(bounds.height).toBeGreaterThanOrEqual(44)
    await remove.tap()
    await touch.waitForFunction(() => document.querySelectorAll(".execution-inbox-row").length === 6)
  } finally {
    await context.close()
  }
})

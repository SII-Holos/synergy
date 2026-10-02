import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
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
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []

beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "synergy-delegation-fixture-")))
  await symlink(path.resolve(source, "../node_modules"), path.join(directory, "node_modules"), "dir")
  await Bun.write(path.join(directory, "package.json"), '{"type":"module"}')
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import {createGlobalEmitter} from "@solid-primitives/event-bus"
    const metric=()=>({known:0,unknown:0,total:0})
    const accounting=()=>({version:1,calls:0,importedCalls:0,localCalls:0,attempts:0,unobservedCalls:0,journalGaps:0,legacy:{cost:0,messages:0},tokens:Object.fromEntries(["input","uncached","cacheRead","cacheWrite","output","reasoning","total"].map(k=>[k,metric()])),apiEstimate:metric(),subscriptionEquivalent:metric(),unclassifiedEquivalent:metric(),reported:{currencies:{},unreported:0},units:{},cacheWrites:{}})
    const node=(id,sessionID,kind,title,parentID=null)=>({id,sessionID,runID:sessionID+"-round",kind,title,parentID,preview:title,started:1,ended:2,status:"completed",revision:1,source:"recorded"})
    const child=node("child","child","subtask","Child analysis","root")
    const nested=node("nested","nested","subtask","Nested analysis","child")
    const task=(n,parentID)=>({sessionID:n.sessionID,nodeID:n.id,parentID,title:n.title,status:"completed",elapsedMs:1,elapsedActive:false,tokens:metric(),runs:[n.runID]})
    const summary={sessionID:"root",revision:1,computedAt:1,status:"completed",elapsedMs:1,elapsedActive:false,accounting:accounting(),own:accounting(),descendants:accounting(),context:null,contextDistribution:null,tasks:[task(child,"root"),task(nested,"child")],rounds:[{id:"root-round",started:1,status:"completed"},{id:"round-2",started:2,status:"completed"}],coverage:{recorded:2,messages:0,gaps:0,partial:false},lanes:[]}
    const records={root:[node("root","root","turn","Root task"),child],child:[child,node("read","child","tool","Read architecture"),nested],nested:[nested,node("answer","nested","output","Nested result")]}
    const exportRows=[...new Map(Object.values(records).flat().map(n=>[n.id,n])).values(),...Array.from({length:600},(_,i)=>node("export-"+i,"root","context","Export row "+i))]
    const event=createGlobalEmitter()
    const long=()=>location.search.includes("long=1")
    const longRows=Array.from({length:10_000},(_,i)=>({...node("long-"+i,"root","tool","Long tool "+i),started:i+1,ended:i+2}))
    const fixtureNode=(id)=>[...exportRows,...longRows].find(n=>n.id===id)
    export const updateFixture=()=>{
      const changed={...longRows[9950],preview:"Updated tool 9950",revision:2}
      const added={...node("long-new","root","tool","New tool"),started:10001,revision:2}
      event.emit("execution.updated",{type:"execution.updated",properties:{sessionID:"root",revision:2,previousRevision:1,summary:{...summary,revision:2},roundSummaries:[],upserts:[changed,added],processUpserts:[changed,added],removed:[]}})
    }
    const sdk={event,client:{session:{executionTrajectory:async(q)=>{
      (window.trajectoryRequests ??= []).push(q)
      if(long()){
        const all=longRows.filter(n=>!q.query || n.title.includes(q.query))
        const anchor=all.findIndex(n=>n.id===q.anchor)
        const limit=q.limit || 100
        const start=q.cursor ? Number(q.cursor) : q.anchor==="latest" ? Math.max(0,all.length-limit) : anchor>=0 ? q.position==="around" ? Math.max(0,anchor-Math.floor(limit/2)) : q.position==="after" ? anchor+1 : anchor : 0
        return {data:{sessionID:q.sessionID,revision:1,total:all.length,items:all.slice(start,start+limit),nextCursor:start+limit<all.length?String(start+limit):null,previousCursor:start>0?String(Math.max(0,start-limit)):null}}
      }
      if(q.limit===500){const start=q.cursor==="page-2"?500:0;return {data:{sessionID:q.sessionID,revision:1,total:exportRows.length,items:exportRows.slice(start,start+500),nextCursor:start===0?"page-2":null,previousCursor:null}}}
      return {data:{sessionID:q.sessionID,revision:1,total:records[q.sessionID].length,items:records[q.sessionID],nextCursor:null,previousCursor:null}}
    },executionSummary:async()=>({data:summary}),executionNode:async(q)=>({data:{node:q.nodeID==="read"?{...fixtureNode(q.nodeID),status:"failed"}:fixtureNode(q.nodeID),record:q.nodeID==="read"?{error:"File not found: architecture.md"}:null,sources:[],definitions:null,related:[]}})}}}
    export const useParams=()=>({id:"root"})
    export const useSDK=()=>sdk
    export const useExecution=()=>({state:{summary},connectionVersion:()=>0})
    export const useWorkbenchPanels=()=>({updateTab:()=>{}})
    export const useNavigateToSession=()=>()=>{}
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {ExecutionWorkbenchContent} from ${JSON.stringify(`${source}/components/execution/panel.tsx`)}
    import {updateFixture} from ${JSON.stringify(`${directory}/services.ts`)}
    window.updateFixture=updateFixture
    import "@ericsanchezok/synergy-ui/styles"
    Object.defineProperty(navigator,"clipboard",{value:{writeText:async(text)=>{window.copiedEvidence=text}}})
    const i18n=setupI18n({locale:"en",messages:{en:{"execution.copyBlock":["Copy ",["label"]],"execution.round":["Round ",["number"]]}}})
    render(()=><I18nProvider i18n={i18n}><DialogProvider><main style="height:780px;width:420px;max-width:100%"><ExecutionWorkbenchContent tab={{id:"context",state:{}}}/></main></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  const services = path.join(directory, "services.ts")
  const options = {
    configFile: false,
    logLevel: "error",
    root: directory,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: {
      alias: [
        ...[
          "@solidjs/router",
          "@/context/sdk",
          "@/context/execution",
          "@/context/workbench",
          "@/composables/use-navigate-to-session",
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
      `import {build} from ${JSON.stringify(Bun.resolveSync("vite", import.meta.dir))}; import solidPlugin from ${JSON.stringify(Bun.resolveSync("vite-plugin-solid", import.meta.dir))}; await build({... ${JSON.stringify(options)}, plugins:[solidPlugin()]}); process.exit(0)`,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "inherit", stderr: "inherit" },
  )
  if (await builder.exited) throw new Error("Execution fixture build failed")
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
  page = await browser.newPage({ viewport: { width: 480, height: 900 } })
  await page.emulateMedia({ reducedMotion: "reduce" })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.locator(".execution-node").first().waitFor()
}, 120_000)

beforeEach(async () => {
  errors.length = 0
  await page.setViewportSize({ width: 480, height: 900 })
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.locator(".execution-node").first().waitFor()
})

afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
}, 30_000)

for (const viewport of [
  { width: 1114, height: 988 },
  { width: 375, height: 667 },
  { width: 768, height: 500 },
  { width: 557, height: 494 },
]) {
  test(
    "expanded task details and their close control fit the compiled dialog at " + viewport.width + "px",
    async () => {
      await page.setViewportSize(viewport)
      await page.goto(server.resolvedUrls!.local[0]!)
      const trigger = page.getByRole("button", { name: "Expand task details", exact: true })
      await trigger.click()
      const modal = page.getByRole("dialog", { name: "Task details", exact: true })
      await modal.waitFor()
      await modal.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
      const bounds = await modal.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const container = element.parentElement!.getBoundingClientRect()
        const close = element.querySelector('[data-slot="dialog-close-button"]')!.getBoundingClientRect()
        const body = element.querySelector('[data-slot="dialog-body"]')!
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          containerWidth: container.width,
          closeRight: close.right,
          bodyWidth: body.clientWidth,
          bodyScrollWidth: body.scrollWidth,
        }
      })
      expect(bounds.left).toBeGreaterThanOrEqual(8)
      expect(bounds.right).toBeLessThanOrEqual(viewport.width - 8)
      expect(bounds.top).toBeGreaterThanOrEqual(8)
      expect(bounds.bottom).toBeLessThanOrEqual(viewport.height - 8)
      expect(bounds.width).toBeCloseTo(bounds.containerWidth, 0)
      expect(bounds.closeRight).toBeLessThanOrEqual(viewport.width - 8)
      expect(bounds.bodyScrollWidth).toBeLessThanOrEqual(bounds.bodyWidth + 1)
      await modal.getByRole("button", { name: "Close dialog", exact: true }).click()
      await modal.waitFor({ state: "hidden" })
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Expand task details")
    },
  )
}

test("round and filter choices show selection and retain keyboard focus within expanded task details", async () => {
  await page.setViewportSize({ width: 1114, height: 988 })
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.getByRole("button", { name: "Expand task details", exact: true }).click()
  const modal = page.getByRole("dialog", { name: "Task details", exact: true })
  await modal.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
  const trigger = modal.getByRole("button", { name: /^Rounds:/ })
  expect(await trigger.count()).toBe(1)
  await trigger.press("Enter")
  const all = page.getByRole("option", { name: "All rounds", exact: true })
  await all.waitFor()
  await all.evaluate((element) =>
    Promise.all(
      element
        .closest(".menu-field-surface")!
        .getAnimations()
        .map((animation) => animation.finished),
    ),
  )
  expect(await all.getAttribute("aria-selected")).toBe("true")
  expect(await all.locator(".menu-field-selection svg").count()).toBe(1)
  expect(await all.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(36)
  await all.press("ArrowDown")
  await page.keyboard.press("Enter")
  await page.waitForFunction(
    () =>
      (window as unknown as { trajectoryRequests: { runID?: string }[] }).trajectoryRequests.at(-1)?.runID ===
      "root-round",
  )
  expect(await trigger.textContent()).toContain("Round 1")
  await trigger.press("Enter")
  await page.getByRole("listbox").press("Escape")
  await page.getByRole("listbox").waitFor({ state: "hidden" })
  expect(await modal.isVisible()).toBe(true)
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Rounds:"))
  await modal.getByRole("button", { name: "Filters", exact: true }).click()
  const filters = page.getByRole("dialog", { name: "Filters", exact: true })
  const tools = filters.getByRole("checkbox", { name: "Tool execution", exact: true })
  await tools.press("Space")
  expect(await tools.isChecked()).toBe(true)
  const control = filters
    .locator(".execution-filter-choice")
    .filter({ hasText: "Tool execution" })
    .locator('[data-slot="checkbox-checkbox-control"]')
  expect(await control.count()).toBe(1)
  expect(await control.evaluate((element) => getComputedStyle(element).borderRadius)).not.toBe("0px")
  const own = filters.getByRole("radio", { name: "Main task", exact: true })
  await own.press("ArrowDown")
  expect(await filters.getByRole("radio", { name: "All tasks", exact: true }).isChecked()).toBe(true)
  for (let index = 0; index < 20; index++) {
    if (await tools.evaluate((element) => element === document.activeElement)) break
    await page.keyboard.press("Tab")
  }
  expect(await tools.evaluate((element) => element === document.activeElement)).toBe(true)
  const focusedBounds = await control.evaluate((element) => {
    const control = element.getBoundingClientRect()
    const body = element.closest('[data-slot="popover-body"]')!.getBoundingClientRect()
    const popup = element.closest('[data-component="popover-content"]')!.getBoundingClientRect()
    return {
      top: control.top,
      bottom: control.bottom,
      bodyTop: body.top,
      bodyBottom: body.bottom,
      popupTop: popup.top,
      popupBottom: popup.bottom,
    }
  })
  expect(focusedBounds.top).toBeGreaterThanOrEqual(focusedBounds.bodyTop)
  expect(focusedBounds.bottom).toBeLessThanOrEqual(focusedBounds.bodyBottom)
  expect(focusedBounds.bodyTop).toBeGreaterThanOrEqual(focusedBounds.popupTop)
  expect(focusedBounds.bodyBottom).toBeLessThanOrEqual(focusedBounds.popupBottom)
  await tools.press("Escape")
  await filters.waitFor({ state: "hidden" })
  expect(await modal.isVisible()).toBe(true)
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Filters")
  await modal.getByRole("button", { name: "Close dialog", exact: true }).click()
  await page.setViewportSize({ width: 480, height: 900 })
  await page.goto(server.resolvedUrls!.local[0]!)
})

for (const width of [1114, 375]) {
  test("activity exploration fits at " + width + "px and returns to expanded task details", async () => {
    await page.setViewportSize({ width, height: 667 })
    await page.getByRole("button", { name: "Expand task details", exact: true }).click()
    const task = page.getByRole("dialog", { name: "Task details", exact: true })
    await task.getByRole("button", { name: "Explore activity", exact: true }).click()
    const activity = page.getByRole("dialog", { name: "Activity", exact: true })
    await activity.waitFor()
    await activity.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
    const box = await activity.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(8)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width - 8)
    const scroll = activity.locator(".execution-chart-scroll")
    expect(await scroll.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto")
    await activity.getByRole("button", { name: "Close dialog", exact: true }).click()
    await activity.waitFor({ state: "hidden" })
    expect(await task.isVisible()).toBe(true)
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Explore activity")
  })
}

test("completed child trajectories expand descendants without recursively offering their own delegation", async () => {
  const child = page.locator(".execution-node-line").getByRole("button", { name: "Child analysis", exact: true })
  await child.waitFor({ timeout: 10_000 })
  await child.click()
  await page.locator('[data-depth="1"]').getByText("Read architecture", { exact: true }).waitFor()
  expect(await child.getAttribute("aria-expanded")).toBe("true")
  expect(
    await page.locator('[data-depth="1"]').getByRole("button", { name: "Child analysis", exact: true }).count(),
  ).toBe(0)
  const nested = page.locator('[data-depth="1"]').getByRole("button", { name: "Nested analysis", exact: true })
  await nested.press("Enter")
  await page.locator('[data-depth="2"]').getByText("Nested result", { exact: true }).waitFor()
  expect(await page.locator('[data-depth="2"] .execution-expand-task').count()).toBe(0)
  expect(errors).toEqual([])
})

test("trajectory export reads every page beyond the loaded window", async () => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export trajectory", exact: true }).click(),
  ])
  const file = await download.path()
  if (!file) throw new Error("Trajectory export did not produce a file")
  const content = await Bun.file(file).json()
  expect(download.suggestedFilename()).toBe("execution-trajectory.json")
  expect(content.summary.sessionID).toBe("root")
  expect(content.nodes).toHaveLength(605)
  expect(new Set(content.nodes.map((node: { id: string }) => node.id)).size).toBe(605)
  expect(content.nodes.at(-1).title).toBe("Export row 599")
  expect(errors).toEqual([])
})

test("a failed tool displays its saved error as the default result without inventing an artifact", async () => {
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.getByRole("button", { name: "Child analysis", exact: true }).click()
  await page.locator('[data-node-id="read"] .execution-node-button').click()
  await page.getByRole("button", { name: "Result", exact: true }).waitFor({ timeout: 3000 })
  const error = page.getByRole("region", { name: "Error details", exact: true })
  expect(await error.locator("code").textContent()).toBe("File not found: architecture.md")
  await error.getByRole("button", { name: "Copy Error details", exact: true }).waitFor({ timeout: 3000 })
  await error.getByRole("button", { name: "Copy Error details", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { copiedEvidence: string }).copiedEvidence)).toBe(
    "File not found: architecture.md",
  )
  expect(await page.locator(".execution-tabs").getByRole("button").count()).toBe(2)
  expect(await page.getByText("File not found: architecture.md", { exact: true }).isVisible()).toBe(true)
  expect((await page.getByText("File not found: architecture.md", { exact: true }).boundingBox())!.y).toBeLessThan(160)
  expect(await page.locator(".execution-global").isVisible()).toBe(false)
}, 15_000)

test("ten thousand persistent events keep rendering bounded and restore history and keyboard focus", async () => {
  await page.goto(server.resolvedUrls!.local[0]! + "?long=1")
  await page.locator('[data-node-id="long-9999"]').waitFor()
  const list = page.locator(".execution-list")
  await page.waitForFunction(() => {
    const element = document.querySelector(".execution-list")!
    return element.scrollTop >= element.scrollHeight - element.clientHeight - 24
  })
  const bounds = (await list.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.wheel(0, -1000)
  await page.waitForFunction(() => {
    const element = document.querySelector(".execution-list")!
    return element.scrollTop < element.scrollHeight - element.clientHeight - 100
  })
  await page.waitForTimeout(80)
  expect(
    await page.locator(".execution-list").evaluate((element) => {
      return element.scrollTop < element.scrollHeight - element.clientHeight - 100
    }),
  ).toBe(true)
  await page.getByRole("button", { name: "Go to latest", exact: true }).waitFor({ timeout: 5000 })
  const visible = await page.locator(".execution-node").evaluateAll((elements) => {
    const top = elements[0]!.closest(".execution-list")!.getBoundingClientRect().top
    const node = elements.find((element) => element.getBoundingClientRect().top >= top)!
    return { id: (node as HTMLElement).dataset.nodeId!, top: node.getBoundingClientRect().top }
  })
  await page.evaluate(() => (window as unknown as { updateFixture: () => void }).updateFixture())
  await page.getByRole("button", { name: /new events/ }).waitFor({ timeout: 5000 })
  const button = page.locator('[data-node-id="' + visible.id + '"] .execution-node-button')
  expect(Math.abs((await button.boundingBox())!.y - visible.top)).toBeLessThan(2)
  await button.press("Enter")
  await page.getByRole("button", { name: "Back to trajectory" }).waitFor()
  expect(await page.locator(".execution-global").isVisible()).toBe(false)
  expect((await page.locator(".execution-inspector-body").boundingBox())!.y).toBeLessThan(160)
  await page.getByRole("button", { name: "Back to trajectory" }).press("Escape")
  await page.waitForTimeout(100)
  expect(await button.evaluate((element) => document.activeElement === element)).toBe(true)
  expect(Math.abs((await button.boundingBox())!.y - visible.top)).toBeLessThan(2)
  expect(await page.locator(".execution-node").count()).toBeLessThanOrEqual(120)
  await page.getByRole("textbox", { name: "Search all recorded events" }).fill("Long tool 3456")
  await page.getByText("Long tool 3456", { exact: true }).waitFor()
  expect(await page.locator(".execution-node").count()).toBe(1)
  expect(errors).toEqual([])
}, 30_000)

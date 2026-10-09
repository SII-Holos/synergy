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
    import {createSignal} from "solid-js"
    const metric=()=>({known:0,unknown:0,total:0})
    const accounting=()=>({version:1,calls:0,importedCalls:0,localCalls:0,attempts:0,unobservedCalls:0,journalGaps:0,legacy:{cost:0,messages:0},tokens:Object.fromEntries(["input","uncached","cacheRead","cacheWrite","output","reasoning","total"].map(k=>[k,metric()])),apiEstimate:metric(),subscriptionEquivalent:metric(),unclassifiedEquivalent:metric(),reported:{currencies:{},unreported:0},units:{},cacheWrites:{}})
    const node=(id,sessionID,kind,title,parentID=null)=>({id,sessionID,runID:sessionID+"-round",kind,title,parentID,preview:title,started:1,ended:2,status:"completed",revision:1,source:"recorded"})
    const child=node("child","child","subtask","Child analysis","root")
    const nested=node("nested","nested","subtask","Nested analysis","child")
    const task=(n,parentID)=>({sessionID:n.sessionID,nodeID:n.id,parentID,title:n.title,status:"completed",elapsedMs:17000,elapsedActive:false,elapsedLowerBound:true,tokens:metric(),runs:[n.runID]})
    const rate={value:null,tokens:0,milliseconds:0,samples:0,excluded:0}
    const latency={samples:0,excluded:0,totalMs:0,meanMs:null,p50Ms:null,p95Ms:null}
    const summary={sessionID:"root",revision:1,computedAt:1,status:"completed",elapsedMs:1,elapsedActive:false,accounting:accounting(),own:accounting(),descendants:accounting(),rates:{generation:rate,endToEnd:rate},cache:{ratio:null,observedRatio:null,read:0,input:0,samples:0,excluded:0},latency:{headers:latency,firstByte:latency,ttft:latency,request:latency,generation:latency},outcomes:{completed:0,failed:0,cancelled:0,interrupted:0,running:0,retries:0,logicalRetries:0,transportRetries:0,rootTasks:0},tools:[{tool:"read",calls:2,failed:1,timedSamples:2,durationMs:100}],context:null,contextDistribution:null,tasks:[task(child,"root"),task(nested,"child")],rounds:[{id:"root-round",started:1,status:"completed",elapsedMs:3000,elapsedActive:false,elapsedLowerBound:false},{id:"round-2",started:2,status:"completed"}],coverage:{recorded:2,messages:0,gaps:0,partial:false},lanes:[]}
    const records={root:[node("root","root","turn","Root task"),child],child:[child,node("read","child","tool","Read architecture"),nested],nested:[nested,node("answer","nested","output","Nested result")]}
    const exportRows=[...new Map(Object.values(records).flat().map(n=>[n.id,n])).values(),...Array.from({length:600},(_,i)=>node("export-"+i,"root","context","Export row "+i))]
    const event=createGlobalEmitter()
    const long=()=>location.search.includes("long=1")
    const longRows=Array.from({length:10_000},(_,i)=>({...node("long-"+i,"root","tool","Long tool "+i),started:i+1,ended:i+2}))
    const model={...node("model","root","model","Test model"),modelID:"test-model",evidenceKind:"call",tokens:{known:1250,total:1250,unknown:0}}
    const fixtureNode=(id)=>id==="model"?model:[...exportRows,...longRows].find(n=>n.id===id)
    export const updateFixture=()=>{
      const changed={...longRows[9950],preview:"Updated tool 9950",revision:2}
      const added={...node("long-new","root","tool","New tool"),started:10001,revision:2}
      event.emit("execution.updated",{type:"execution.updated",properties:{sessionID:"root",revision:2,previousRevision:1,summary:{...summary,revision:2},roundSummaries:[],upserts:[changed,added],processUpserts:[changed,added],removed:[]}})
    }
    const sdk={event,connected:()=>true,client:{session:{executionTrajectory:async(q,options)=>{
      (window.trajectoryRequests ??= []).push(q)
      if(location.search.includes("membership=1")){
        const items=[model].filter(n=>!q.query || n.title.includes(q.query))
        if(window.holdTrajectory)await new Promise((resolve,reject)=>(window.pendingTrajectories ??= []).push({resolve,reject,signal:options.signal}))
        return {data:{sessionID:q.sessionID,revision:1,total:items.length,items,nextCursor:null,previousCursor:null}}
      }
      if(location.search.includes("failed=1"))return {data:{sessionID:q.sessionID,revision:1,total:1,items:[{...node("failed-tool","root","tool","skill"),tool:"skill",status:"failed",preview:'{"name":"context-review"}'}],nextCursor:null,previousCursor:null}}
      if(long()){
        const all=longRows.filter(n=>!q.query || n.title.includes(q.query))
        const anchor=all.findIndex(n=>n.id===q.anchor)
        const limit=q.limit || 100
        const start=q.cursor ? Number(q.cursor) : q.anchor==="latest" ? Math.max(0,all.length-limit) : anchor>=0 ? q.position==="around" ? Math.max(0,anchor-Math.floor(limit/2)) : q.position==="after" ? anchor+1 : anchor : 0
        return {data:{sessionID:q.sessionID,revision:1,total:all.length,items:all.slice(start,start+limit),nextCursor:start+limit<all.length?String(start+limit):null,previousCursor:start>0?String(Math.max(0,start-limit)):null}}
      }
      if(q.limit===500){const start=q.cursor==="page-2"?500:0;return {data:{sessionID:q.sessionID,revision:1,total:exportRows.length,items:exportRows.slice(start,start+500),nextCursor:start===0?"page-2":null,previousCursor:null}}}
      return {data:{sessionID:q.sessionID,revision:1,total:records[q.sessionID].length,items:records[q.sessionID],nextCursor:null,previousCursor:null}}
    },executionSummary:async()=>{if(window.holdSummary)await new Promise(resolve=>{window.releaseSummary=resolve});return {data:summary}},executionNode:async(q)=>({data:{node:q.nodeID==="read"?{...fixtureNode(q.nodeID),status:"failed"}:fixtureNode(q.nodeID),record:q.nodeID==="read"?{error:"File not found: architecture.md"}:null,sources:q.nodeID==="model" && !location.search.includes("missing=1")?[{field:"request",artifact:{bytes:100}},{field:"response",artifact:{bytes:100}}]:[],definitions:null,related:[]}}),executionContent:async(q,options)=>{(window.contentRequests ??= []).push(q);if(location.search.includes("pending=1"))await new Promise(resolve=>(window.pendingEvidence ??= []).push({signal:options.signal,resolve}));return {data:{available:true,status:"complete",contentVersion:"v1",mediaType:"application/json",text:'{"test": true}',offset:0,bytes:14,totalBytes:14,nextOffset:null}}}}}}
    export const useParams=()=>({id:"root"})
    export const useSDK=()=>sdk
    const snapshots=[1,2].map(n=>({sessionID:"root",callID:"call-"+n,nodeID:"model",runID:"root-round",requestNumber:n,roundNumber:1,started:n,modelID:"test-model",providerID:"test-provider",status:"completed",inputTokens:n*100,outputTokens:10,cacheHit:0.5,elapsedMs:1000,retries:0,usage:null,compactedBefore:false,requestAvailable:true,contextLimit:10000}))
    export const useExecution=()=>({available:()=>true,advance:()=>0,connected:()=>true,state:{summary},connectionVersion:()=>0,createContextHistory:(options)=>{window.contextActive=options.active;return {state:{items:snapshots,total:2,latest:snapshots[1],loading:false,error:false},snapshot:()=>snapshots.find(n=>n.callID===options.selected())??snapshots[1],load:async()=>{}}}})
    export const [fixtureTab,setFixtureTab]=createSignal({id:"context",state:{}})
    export const useWorkbenchPanels=()=>({surface:()=>({opened:()=>true,active:()=>"context"}),updateTab:(id,patch)=>{window.recordedTab=patch.state;(window.stateWrites??=[]).push(patch.state);if(window.stateWrites.length>30)throw new Error("Execution state did not settle");setFixtureTab({id,...patch})}})
    export const useNavigateToSession=()=>()=>{}
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {Show} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {ExecutionPanelBody} from ${JSON.stringify(`${source}/components/execution/panel.tsx`)}
    import {ContextWorkbenchContent} from ${JSON.stringify(`${source}/components/execution/context-dashboard.tsx`)}
    import {updateFixture,fixtureTab} from ${JSON.stringify(`${directory}/services.ts`)}
    window.updateFixture=updateFixture
    import "@ericsanchezok/synergy-ui/styles"
    Object.defineProperty(navigator,"clipboard",{value:{writeText:async(text)=>{window.copiedEvidence=text}}})
    const i18n=setupI18n({locale:"en",messages:{en:{"execution.copyBlock":["Copy ",["label"]],"execution.round":["Round ",["number"]],"context.dashboard.request":["Request ",["number"]]}}})
    render(()=><I18nProvider i18n={i18n}><DialogProvider><main style="height:100dvh;width:100%;max-width:100%;padding:8px;box-sizing:border-box"><Show when={location.search.includes("dashboard=1")} fallback={<ExecutionPanelBody tab={{id:"context",state:location.search.includes("model=1")?{nodeID:"model"}:{}}} runID={location.search.includes("scoped=1")?"root-round":""} scopeLabel="Entire task" onStateChange={(state)=>{window.recordsState=state}} onBack={()=>{window.returnedToOverview=true}}/>}><ContextWorkbenchContent tab={fixtureTab()}/></Show></main></DialogProvider></I18nProvider>,document.getElementById("root"))
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
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
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
  { width: 320, height: 600 },
  { width: 768, height: 500 },
  { width: 557, height: 494 },
]) {
  test("execution records fit their workspace at " + viewport.width + "px", async () => {
    await page.setViewportSize(viewport)
    await page.goto(server.resolvedUrls!.local[0]!)
    const panel = page.locator(".execution-panel")
    await panel.waitFor()
    const bounds = await panel.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }
    })
    expect(bounds.left).toBeGreaterThanOrEqual(8)
    expect(bounds.right).toBeLessThanOrEqual(viewport.width - 8)
    expect(bounds.top).toBeGreaterThanOrEqual(8)
    expect(bounds.bottom).toBeLessThanOrEqual(viewport.height - 8)
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1)
    expect(await panel.getByRole("button", { name: "Expand task details", exact: true }).count()).toBe(0)
  })
}

test("records inherit the dashboard scope without rendering a second overview", async () => {
  await page.goto(server.resolvedUrls!.local[0]! + "?scoped=1")
  await page.locator(".execution-node").first().waitFor()
  expect(await page.locator(".execution-overview").count()).toBe(0)
  expect(await page.getByRole("button", { name: /^Rounds:/ }).count()).toBe(0)
  expect(
    await page.evaluate(
      () => (window as unknown as { trajectoryRequests: { runID?: string }[] }).trajectoryRequests.at(-1)?.runID,
    ),
  ).toBe("root-round")
  await page.getByRole("button", { name: "Back to overview", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { returnedToOverview: boolean }).returnedToOverview)).toBe(
    true,
  )
})

test("wide inspection bounds the process column and keeps detail values left aligned", async () => {
  await page.setViewportSize({ width: 1000, height: 946 })
  await page.goto(server.resolvedUrls!.local[0]! + "?model=1")
  const inspector = page.getByRole("region", { name: "Inspect event", exact: true })
  await inspector.getByText("Test model", { exact: true }).waitFor()
  const process = (await page.locator(".execution-trajectory-pane").boundingBox())!
  const detail = (await inspector.boundingBox())!
  expect(process.width).toBeGreaterThanOrEqual(280)
  expect(process.width).toBeLessThanOrEqual(320)
  expect(detail.x).toBeGreaterThan(process.x + process.width)
  expect(detail.width).toBeGreaterThan(process.width)
  expect(
    await inspector
      .locator(".execution-detail-rows dd")
      .first()
      .evaluate((element) => getComputedStyle(element).textAlign),
  ).toBe("left")
})

test("narrow inspection replaces the process controls with readable evidence", async () => {
  for (const width of [375, 426]) {
    await page.setViewportSize({ width, height: 946 })
    await page.goto(server.resolvedUrls!.local[0]!)
    await page.getByRole("button", { name: "Child analysis", exact: true }).click()
    await page.locator('[data-node-id="read"] .execution-node-button').click()
    const body = page.getByRole("region", { name: "Error details", exact: true }).locator("code")
    await body.waitFor()
    expect(await page.locator(".execution-trajectory-pane").isVisible()).toBe(false)
    expect(await page.getByRole("textbox", { name: "Search all recorded events" }).isVisible()).toBe(false)
    const reading = await body.evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      fontSize: getComputedStyle(element).fontSize,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }))
    expect(reading.top).toBeLessThanOrEqual(946 / 3)
    expect(reading.fontSize).toBe("14px")
    expect(reading.overflow).toBe(false)
    await page.getByRole("button", { name: "Back to trajectory", exact: true }).click()
    expect(await page.getByRole("textbox", { name: "Search all recorded events" }).isVisible()).toBe(true)
  }
})

test("model inspection keeps summary, request, response and timing in one scrolling document", async () => {
  await page.setViewportSize({ width: 560, height: 600 })
  await page.goto(server.resolvedUrls!.local[0]! + "?model=1")
  await page.getByRole("region", { name: "Inspect event", exact: true }).waitFor()
  await page.getByText("Test model", { exact: true }).waitFor()
  expect(await page.getByRole("navigation", { name: "View", exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Saved request", exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "Provider response", exact: true }).count()).toBe(0)
  const request = page.getByRole("region", { name: "Saved request", exact: true })
  const response = page.getByRole("region", { name: "Provider response", exact: true })
  const timing = page.getByRole("region", { name: "Timing", exact: true })
  await request.locator("code").waitFor()
  await response.locator("code").waitFor()
  const body = page.locator(".execution-inspector-body")
  const order = await body.evaluate((element) =>
    [...element.children].map((child) => child.getAttribute("aria-label") ?? child.className),
  )
  expect(order).toEqual(["execution-request-summary", "Saved request", "Provider response", "Timing"])
  const reads = await page.evaluate(
    () => (window as unknown as { contentRequests: { field: string; limit: number }[] }).contentRequests,
  )
  expect(reads.map((read) => read.field).sort()).toEqual(["request", "response"])
  expect(reads.every((read) => read.limit <= 65_536)).toBe(true)
  await timing.scrollIntoViewIfNeeded()
  expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await timing.isVisible()).toBe(true)
  expect(await request.count()).toBe(1)
  expect(await response.count()).toBe(1)
  expect(errors).toEqual([])
}, 15_000)

test("pending request and response reads leave metadata readable and abort together on navigation", async () => {
  await page.goto(server.resolvedUrls!.local[0]! + "?model=1&pending=1")
  await page.getByText("Test model", { exact: true }).waitFor()
  await page.waitForFunction(() => (window as unknown as { pendingEvidence?: unknown[] }).pendingEvidence?.length === 2)
  expect(await page.locator(".execution-request-summary").isVisible()).toBe(true)
  expect(await page.getByRole("region", { name: "Timing", exact: true }).count()).toBe(1)
  await page.getByRole("button", { name: "Back to trajectory", exact: true }).click()
  const cancelled = await page.evaluate(() => {
    const pending = (window as unknown as { pendingEvidence: { signal: AbortSignal; resolve: () => void }[] })
      .pendingEvidence
    const aborted = pending.every((read) => read.signal.aborted)
    pending.forEach((read) => read.resolve())
    return aborted
  })
  expect(cancelled).toBe(true)
  expect(await page.getByRole("region", { name: "Inspect event", exact: true }).count()).toBe(0)
  expect(await page.locator(".execution-reader").count()).toBe(0)
  expect(errors).toEqual([])
}, 15_000)

test("model inspection without recorded bodies retains summary and timing without dead controls", async () => {
  await page.goto(server.resolvedUrls!.local[0]! + "?model=1&missing=1")
  await page.getByText("Test model", { exact: true }).waitFor()
  expect(await page.locator(".execution-request-summary").isVisible()).toBe(true)
  expect(await page.getByRole("region", { name: "Timing", exact: true }).count()).toBe(1)
  expect(await page.getByRole("navigation", { name: "View", exact: true }).count()).toBe(0)
  expect(await page.locator(".execution-reader").count()).toBe(0)
  expect(
    await page.evaluate(() => (window as unknown as { contentRequests?: unknown[] }).contentRequests ?? []),
  ).toEqual([])
  expect(errors).toEqual([])
}, 15_000)

test("changing record order never flashes an outside-filter warning while the page is pending", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(server.resolvedUrls!.local[0]! + "?model=1&membership=1")
  await page.locator('.execution-node[data-node-id="model"]').waitFor()
  await page.getByRole("button", { name: "All records", exact: true }).click()
  await page.locator('.execution-node[data-node-id="model"]').waitFor()
  await page.evaluate(() => {
    ;(window as unknown as { holdTrajectory: boolean }).holdTrajectory = true
  })
  const inspector = page.getByRole("region", { name: "Inspect event", exact: true })
  for (const name of ["Rounds", "Calls", "Time"]) {
    await page.getByRole("button", { name, exact: true }).click()
    await page.waitForFunction(
      () => (window as unknown as { pendingTrajectories?: unknown[] }).pendingTrajectories?.length === 1,
    )
    expect(await inspector.innerText()).not.toContain("Outside current filters")
    expect(await inspector.locator(".execution-request-summary").isVisible()).toBe(true)
    await page.evaluate(() => {
      ;(window as unknown as { pendingTrajectories: { resolve: () => void }[] }).pendingTrajectories.shift()!.resolve()
    })
    await page.locator('.execution-node[data-node-id="model"]').waitFor()
    expect(await inspector.innerText()).not.toContain("Outside current filters")
  }
  expect(await page.evaluate(() => (window as unknown as { contentRequests: unknown[] }).contentRequests.length)).toBe(
    2,
  )
  expect(errors).toEqual([])
}, 15_000)

test("a confirmed outside-filter warning survives loading failures and clears only after a matching result", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(server.resolvedUrls!.local[0]! + "?model=1&membership=1")
  await page.locator('.execution-node[data-node-id="model"]').waitFor()
  await page.getByRole("button", { name: "All records", exact: true }).click()
  await page.locator('.execution-node[data-node-id="model"]').waitFor()
  await page.evaluate(() => {
    ;(window as unknown as { holdTrajectory: boolean }).holdTrajectory = true
  })
  await page.locator(".execution-search input").fill("No matching record")
  await page.waitForFunction(
    () => (window as unknown as { pendingTrajectories?: unknown[] }).pendingTrajectories?.length === 1,
  )
  const inspector = page.getByRole("region", { name: "Inspect event", exact: true })
  expect(await inspector.innerText()).not.toContain("Outside current filters")
  await page.evaluate(() => {
    ;(window as unknown as { pendingTrajectories: { resolve: () => void }[] }).pendingTrajectories.shift()!.resolve()
  })
  await inspector.getByText("· Outside current filters", { exact: false }).waitFor()
  await page.getByRole("button", { name: "Rounds", exact: true }).click()
  await page.waitForFunction(
    () => (window as unknown as { pendingTrajectories: unknown[] }).pendingTrajectories.length === 1,
  )
  expect(await inspector.innerText()).toContain("Outside current filters")
  await page.evaluate(() => {
    ;(window as unknown as { pendingTrajectories: { reject: (error: Error) => void }[] }).pendingTrajectories
      .shift()!
      .reject(new Error("Page unavailable"))
  })
  await page.getByRole("alert").waitFor()
  expect(await inspector.innerText()).toContain("Outside current filters")
  await page.evaluate(() => {
    ;(window as unknown as { holdTrajectory: boolean }).holdTrajectory = false
  })
  await page.locator(".execution-search input").fill("")
  await page.locator('.execution-node[data-node-id="model"]').waitFor()
  expect(await inspector.innerText()).not.toContain("Outside current filters")
  expect(errors).toEqual([])
}, 15_000)

test("a superseded filter result cannot change the selected inspector's confirmed membership", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(server.resolvedUrls!.local[0]! + "?model=1&membership=1")
  await page.locator('.execution-node[data-node-id="model"]').waitFor()
  await page.evaluate(() => {
    ;(window as unknown as { holdTrajectory: boolean }).holdTrajectory = true
  })
  const search = page.locator(".execution-search input")
  await search.fill("No matching record")
  await page.waitForFunction(
    () => (window as unknown as { pendingTrajectories?: unknown[] }).pendingTrajectories?.length === 1,
  )
  await search.fill("Test model")
  await page.waitForFunction(
    () => (window as unknown as { pendingTrajectories: unknown[] }).pendingTrajectories.length === 2,
  )
  expect(
    await page.evaluate(() => {
      const pending = (window as unknown as { pendingTrajectories: { signal: AbortSignal; resolve: () => void }[] })
        .pendingTrajectories
      pending[1].resolve()
      return pending[0].signal.aborted
    }),
  ).toBe(true)
  await page.locator('.execution-node[data-node-id="model"]').waitFor()
  await page.evaluate(async () => {
    ;(window as unknown as { pendingTrajectories: { resolve: () => void }[] }).pendingTrajectories[0].resolve()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  expect(await page.locator(".execution-inspector-title").innerText()).not.toContain("Outside current filters")
  expect(await page.locator('.execution-node[data-node-id="model"]').count()).toBe(1)
  expect(errors).toEqual([])
}, 15_000)

test("filter choices show selection and retain keyboard focus within execution records", async () => {
  await page.setViewportSize({ width: 1114, height: 988 })
  await page.goto(server.resolvedUrls!.local[0]!)
  const modal = page.locator(".execution-panel")
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
  await page.setViewportSize({ width: 480, height: 900 })
  await page.goto(server.resolvedUrls!.local[0]!)
})

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
  expect(
    (await page.getByText("File not found: architecture.md", { exact: true }).boundingBox())!.y,
  ).toBeLessThanOrEqual(page.viewportSize()!.height / 3)
  expect(await page.locator(".execution-trajectory-pane").isVisible()).toBe(false)
}, 15_000)

test("failed tool rows display their tool name instead of serialized parameters", async () => {
  await page.goto(server.resolvedUrls!.local[0]! + "?failed=1")
  const row = page.locator('[data-node-id="failed-tool"]')
  await row.waitFor()
  expect(await row.locator("strong").textContent()).toBe("skill")
  expect(await row.innerText()).not.toContain('{"name"')
})

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
  expect(await page.locator(".execution-trajectory-pane").isVisible()).toBe(false)
  expect((await page.locator(".execution-inspector-body").boundingBox())!.y).toBeLessThanOrEqual(
    page.viewportSize()!.height / 3,
  )
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

test("task and round rows use recorded intervals instead of their transcript envelope", async () => {
  expect(await page.locator('[data-node-id="child"] .execution-node-meta').textContent()).toContain("≥ 00:17")
  expect(await page.locator('[data-node-id="root"] .execution-node-meta').textContent()).toContain("00:03")
})

test("dashboard request inspection returns to the same scope, selection, focus and reading position", async () => {
  await page.setViewportSize({ width: 560, height: 800 })
  await page.goto(server.resolvedUrls!.local[0]! + "?dashboard=1")
  await page.getByRole("button", { name: "Request 1 · 100", exact: true }).click()
  const open = page.getByRole("button", { name: "Request details", exact: true })
  await open.scrollIntoViewIfNeeded()
  const scroll = await page.locator(".context-dashboard").evaluate((element) => element.scrollTop)
  await open.click()
  await page.locator(".execution-request-summary").waitFor()
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Back to trajectory")
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { recordedTab: { contextDashboard: { records: boolean } } }).recordedTab.contextDashboard
          .records,
    ),
  ).toBe(true)
  expect(await page.locator(".execution-overview").count()).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { contextActive: () => boolean }).contextActive())).toBe(true)
  await page.getByRole("button", { name: "Back to overview", exact: true }).click()
  await open.waitFor()
  expect(errors).toEqual([])
  expect(await page.getByRole("button", { name: "Request 1 · 100", exact: true }).getAttribute("aria-pressed")).toBe(
    "true",
  )
  expect(await page.locator(".context-dashboard").evaluate((element) => element.scrollTop)).toBe(scroll)
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Request details")
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { recordedTab: { contextDashboard: { records: boolean; runID: string } } }).recordedTab
          .contextDashboard,
    ),
  ).toMatchObject({ records: false, runID: "" })
  expect(errors).toEqual([])
}, 15_000)

test("returning to a round keeps its metric cards while the background summary refresh is pending", async () => {
  await page.goto(server.resolvedUrls!.local[0]! + "?dashboard=1")
  await page.getByRole("button", { name: /^Rounds:/ }).click()
  await page.getByRole("option").nth(1).click()
  await page.getByRole("region", { name: "Token statistics", exact: true }).waitFor()
  await page.evaluate(() => {
    ;(window as unknown as { usageCard: Element | null }).usageCard = document.querySelector(".context-usage-stats")
  })
  await page.getByRole("button", { name: "Request details", exact: true }).click()
  await page.locator(".execution-request-summary").waitFor()
  await page.evaluate(() => {
    ;(window as unknown as { holdSummary: boolean }).holdSummary = true
  })
  await page.getByRole("button", { name: "Back to overview", exact: true }).click()
  expect(await page.getByRole("region", { name: "Token statistics", exact: true }).count()).toBe(1)
  expect(
    await page.evaluate(
      () => document.querySelector(".context-usage-stats") === (window as unknown as { usageCard: Element }).usageCard,
    ),
  ).toBe(true)
  await page.evaluate(() => {
    ;(window as unknown as { releaseSummary?: () => void }).releaseSummary?.()
  })
  expect(errors).toEqual([])
}, 15_000)

test("the failure count opens failed tools across the same task and its descendants", async () => {
  await page.goto(server.resolvedUrls!.local[0]! + "?dashboard=1")
  await page.locator(".context-activity-counts button[data-state=failed]").click()
  await page.locator(".execution-node").first().waitFor()
  expect(
    await page.evaluate(() => (window as unknown as { trajectoryRequests: unknown[] }).trajectoryRequests.at(-1)),
  ).toMatchObject({ kinds: "tool", statuses: "failed", actor: "all" })
  expect(await page.locator(".execution-inspector").count()).toBe(0)
  await page.getByRole("button", { name: "Back to overview", exact: true }).click()
  expect(await page.getByRole("region", { name: "Task activity", exact: true }).isVisible()).toBe(true)
  expect(errors).toEqual([])
})

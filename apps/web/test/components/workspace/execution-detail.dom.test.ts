import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { build, preview, type PreviewServer } from "vite"
import solid from "vite-plugin-solid"

type Fixture = {
  features(features: string[] | undefined): void
  required(features: string[]): void
  event(kind: "agent-delivery" | "compaction", messageID?: string): void
  child(
    taskID: string,
    value: string,
    mode?: "summary" | "final_response" | "structured",
    identity?: { parentSessionID?: string; sessionID?: string },
  ): void
  resolveEvent(index: number, text: string, state?: "running" | "committed" | "failed", mechanical?: boolean): void
  refreshEvent(): void
  rejectEvent(index: number): void
  taskOutput(index: number, output: unknown, mode?: string, taskID?: string): void
  switchOwner(server: string, scope: string, sessionID?: string): void
  select(partID: string): void
  activity(revision: number, messageID?: string): void
  resolve(
    index: number,
    output: string,
    activity?: {
      kind: "search" | "object" | "file-read" | "media" | "file-change"
      text: string
      mediaType?: string
      path?: string
      tool?: string
      truncated?: boolean
      metadata?: Record<string, unknown>
    },
  ): void
  fail(index: number, error: string): void
  patch(index: number): void
  resolveCommand(
    index: number,
    process: { status: "running" | "completed" | "interrupted" | "failed"; exitCode?: number | null; signal?: string },
    text: string,
    toolError?: string,
  ): void
  close(): void
  facts(): {
    requests: number
    aborted: boolean[]
    resultUnmounts: number
    copied: string
    taskRequests: Array<{ taskID: string; parentSessionID?: string; sessionID?: string }>
    sessionReads: number
  }
}
let server: PreviewServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
const inspect = () => page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.facts())

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".execution-detail-"))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><style>body{margin:0}#root{height:480px}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "bridge.tsx"),
    `
    import {batch,createSignal,onCleanup} from "solid-js"
    import {createStore} from "solid-js/store"
    import {configureClipboard,createCopyController} from ${JSON.stringify(path.resolve(appSrc, "../../../packages/ui/src/components/clipboard-core.ts"))}
    const [owner,setOwner]=createStore({server:"server-a",scope:"scope-a",sessionID:"session"})
    const [state,setState]=createSignal({...owner,messageID:"message",partID:"part-a",callID:"call-part-a"})
    const [open,setOpen]=createSignal(true)
    const [selection,setSelection]=createSignal({features:["note","blueprint","media"]})
    const requests=[]
    const taskRequests=[]
    let sessionReads=0
    let activityListener
    let resultUnmounts=0
    let copied=""
    let child={taskID:"ctx_original",parentSessionID:"session",output:{mode:"final_response",value:"Saved child result"}}
    const [eventLive,setEventLive]=createSignal()
    configureClipboard({writer(text){copied=text}})
    const h=window.fixture={state,open,
      features:features=>setSelection(features ? {features} : undefined),
      required:requiredFeatures=>setState({...state(),requiredFeatures}),
      event(kind,messageID="event"){setState({...owner,kind,messageID})},
      child(taskID,value,mode="final_response",identity={}){child={taskID,sessionID:"child",parentSessionID:owner.sessionID,status:"completed",startedAt:1,completedAt:146001,output:{mode,value},...identity}},
      resolveEvent(index,text,status="committed",mechanical=false){
        const request=requests[index]
        const info={id:request.messageID,sessionID:request.sessionID,role:request.kind==="compaction"?"assistant":"user",time:{created:1,completed:status==="running"?undefined:2},metadata:request.kind==="compaction"?{compactionAttempt:{state:status}}:undefined,origin:request.kind==="agent-delivery"?{type:"cortex",sessionID:"child",taskID:"ctx_original",label:"Evidence review"}:undefined,error:status==="failed"?{name:"UnknownError",data:{message:text}}:undefined}
        request.resolve({data:{info,parts:[{id:"event-part",messageID:info.id,sessionID:info.sessionID,type:request.kind==="compaction"&&status==="committed"?"compaction_recovery":"text",text,summary:request.kind==="compaction"?text:undefined,mechanical}]}})
      },
      refreshEvent(){setEventLive({id:state().messageID,time:{created:1,completed:3},metadata:{compactionAttempt:{state:"committed"}}})},
      rejectEvent(index){requests[index].reject({data:{message:"Temporary process detail failure"}})},
      switchOwner(server,scope,sessionID="session"){batch(()=>{setOwner({server,scope,sessionID});setState({...owner,messageID:"message",partID:"part-a",callID:"call-part-a"})})},
      select(partID){setState({...state(),partID,callID:"call-"+partID})},
      activity(revision,messageID="message"){activityListener?.({properties:{sessionID:owner.sessionID,messageID,callID:state().callID,revision}})},
      resolve(index,output,activity){const request=requests[index];request.resolve({data:{evidenceMissing:!activity,truncated:activity?.truncated,text:activity?.text,part:{id:request.partID,callID:request.callID,messageID:"message",sessionID:request.sessionID,type:"tool",tool:activity?.tool??"read",activityEvidence:activity?{kind:activity.kind,mediaType:activity.mediaType??"application/json",resource:{path:activity.path},range:activity.kind==="file-read"?{startLine:0,lineCount:activity.text.split("\\n").length}:undefined}:undefined,state:{status:"completed",input:{filePath:"/fixture.txt"},metadata:activity?.metadata,output,time:{start:1,end:2}}}}})},
      taskOutput(index,output,mode="full",taskID="ctx_original"){const request=requests[index];request.resolve({data:{evidenceMissing:false,text:"Task receipt",part:{id:request.partID,callID:request.callID,messageID:request.messageID,sessionID:request.sessionID,type:"tool",tool:"task_output",state:{status:"completed",input:{taskId:"ctx_original",mode},metadata:{found:true,taskId:taskID,status:"error",mode,output},output:"Task receipt",time:{start:1,end:2}}}}})},
      fail(index,error){const request=requests[index];request.resolve({data:{evidenceMissing:true,part:{id:request.partID,callID:request.callID,messageID:"message",sessionID:request.sessionID,type:"tool",tool:"read",state:{status:"error",input:{filePath:"/fixture.txt"},error,time:{start:1,end:2}}}}})},
      patch(index){const request=requests[index];request.resolve({data:{evidenceMissing:true,part:{id:request.partID,callID:request.callID,messageID:"message",sessionID:request.sessionID,type:"tool",tool:"apply_patch",state:{status:"error",input:{patch:"retained patch"},metadata:{outcome:"unresolved",sections:[{source:"source.ts",state:"unknown",operations:[{phase:"write",state:"unknown"}]}]},error:"Patch outcome unconfirmed",time:{start:1,end:2}}}}})},
      resolveCommand(index,process,text,toolError){const request=requests[index];request.resolve({data:{evidenceMissing:false,text,process,part:{id:request.partID,callID:request.callID,messageID:"message",sessionID:request.sessionID,type:"tool",tool:"bash",workBrief:"Check the foreground wait command.",activityEvidence:{kind:"command"},state:{status:toolError?"error":"completed",input:{command:'printf waiting && sleep 90'},error:toolError,output:toolError?undefined:text,time:{start:1,end:33401}}}}})},
      close(){setOpen(false)},facts(){return {requests:requests.length,aborted:requests.map(request=>request.signal.aborted),resultUnmounts,copied,taskRequests,sessionReads}}
    }
    export {h}
    export const useGlobalSDK=()=>({capabilities:{current:selection,has:id=>selection()?.features.includes(id)??false}})
    export const useSDK=()=>({get url(){return owner.server},get scopeKey(){return owner.scope},event:{on(type,listener){activityListener=listener;return()=>{activityListener=undefined}}},client:{cortex:{get:async(target)=>{taskRequests.push(target);return {data:{...child,id:child.taskID}}}},session:{message:async(target,options)=>new Promise((resolve,reject)=>requests.push({...target,kind:state().kind,signal:options.signal,resolve,reject})),get:async()=>{sessionReads++;const {output,...summary}=child;return {data:{id:"child",parentID:owner.sessionID,cortex:summary}}},toolActivity:async(target,options)=>new Promise((resolve,reject)=>requests.push({...target,partID:state().partID,signal:options.signal,resolve,reject}))}}})
    export const useParams=()=>({get id(){return owner.sessionID}})
    export const useSessionDataView=()=>()=>({messagesFor:()=>eventLive()?[eventLive()]:[],partsFor:()=>[]})
    export const useData=()=>({navigateToSession(){}})
    export const useWorkbenchPanels=()=>({updateTab(id,patch){setState(patch.state)}})
    export const Button=props=><button {...props}>{props.children}</button>
    export const ToolResultBody=props=>{onCleanup(()=>resultUnmounts++);return <output data-result>{props.part.state.error??props.part.state.output}</output>}
    export const AttachmentGallery=()=>null
    export const resolveExternalToolRenderer=tool=>tool==="fixture.plugin"?{}:undefined
    export const externalLookup=undefined
    export const externalLoadNotify=()=>0
    export const Icon=()=> <span/>
    export {compactionErrorText,resolveCompactionCardPresentation} from ${JSON.stringify(path.resolve(appSrc, "../../../packages/ui/src/components/compaction-card-model.ts"))}
    export const ErrorCard=props=><div><p>{props.error}</p>{props.actions}</div>
    export const getToolInfo=(tool,input)=>({subtitle:input.filePath??input.command})
    export const getSemanticIcon=()=>"arrow-left"
    export {createCopyController}
  `,
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {Show,Suspense} from "solid-js"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {MarkedProvider} from "@ericsanchezok/synergy-ui/context/marked"
    import ${JSON.stringify(path.resolve(appSrc, "../../../packages/ui/src/components/markdown.css"))}
    import {h} from "./bridge"
    import {ExecutionDetailWorkbenchContent} from ${JSON.stringify(`/@fs/${appSrc}/components/workspace/tool-execution-detail.tsx`)}
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><MarkedProvider><Suspense fallback={<p>Loading tool result…</p>}><Show when={h.open()}><ExecutionDetailWorkbenchContent tab={{id:"detail",panelId:"execution-detail",state:h.state()}}/></Show></Suspense></MarkedProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  const bridge = path.join(fixture, "bridge.tsx")
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  await build({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [solid()],
    worker: { format: "es" },
    resolve: {
      alias: Object.fromEntries(
        [
          ["@", appSrc],
          ...[
            "@/context/sdk",
            "@/context/global-sdk",
            "@/context/session-data-view",
            "@/context/workbench",
            "@ericsanchezok/synergy-ui/context/data",
            "@solidjs/router",
            ...[
              "button",
              "icon",
              "tool-result-body",
              "tool-registry-lazy",
              "attachment-card",
              "error-card",
              "message-part",
              "semantic-icon",
              "clipboard",
              "compaction-card",
            ].map((name) => `@ericsanchezok/synergy-ui/${name}`),
          ].map((name) => [name, bridge]),
        ].reverse(),
      ),
    },
    build: { outDir: path.join(fixture, "dist"), minify: false },
    logLevel: "error",
  })
  server = await preview({
    configFile: false,
    root: fixture,
    build: { outDir: path.join(fixture, "dist") },
    preview: { host: "127.0.0.1", port, strictPort: true },
  })
  base = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    )
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("process detail failures remain local, preserve accepted evidence and allow one manual retry", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.event("compaction"))
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.rejectEvent(1))
  await page.getByText("Temporary process detail failure", { exact: true }).waitFor()
  const retry = page.getByRole("button", { name: "Retry loading content", exact: true })
  await retry.focus()
  await retry.press("Enter")
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 3)
  expect(await retry.isDisabled()).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolveEvent(2, "Accepted summary"))
  await page.getByText("Accepted summary", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.refreshEvent())
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 4)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.rejectEvent(3))
  await page.getByText("Temporary process detail failure", { exact: true }).waitFor()
  expect(await page.getByText("Accepted summary", { exact: true }).count()).toBe(1)
  expect(errors).toEqual([])
}, 30000)

test("agent notices read full authorized tasks after Session projection and reject mismatched identity", async () => {
  for (const candidate of [
    { taskID: "ctx_original", identity: {}, accepted: true },
    { taskID: "ctx_later", identity: {}, accepted: false },
    { taskID: "ctx_original", identity: { parentSessionID: "another-parent" }, accepted: false },
    { taskID: "ctx_original", identity: { sessionID: "imported-child" }, accepted: false },
  ]) {
    await page.goto(base)
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
    await page.evaluate((candidate) => {
      const fixture = (window as unknown as { fixture: Fixture }).fixture
      fixture.event("agent-delivery")
      fixture.child(candidate.taskID, "Full original child result", "final_response", candidate.identity)
    }, candidate)
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
    await page.evaluate(() =>
      (window as unknown as { fixture: Fixture }).fixture.resolveEvent(1, "Original notification"),
    )
    await page
      .getByText(candidate.accepted ? "Full original child result" : "Original notification", { exact: true })
      .waitFor()
    expect(
      await page
        .getByText(candidate.accepted ? "Original notification" : "Full original child result", { exact: true })
        .count(),
    ).toBe(0)
    expect((await inspect()).taskRequests).toEqual([
      { taskID: "ctx_original", parentSessionID: "session", sessionID: "child" },
    ])
    expect((await inspect()).sessionReads).toBe(0)
  }
  expect(errors).toEqual([])
}, 30000)

test("agent summary details open the report first and keep execution evidence separately copyable", async () => {
  const report =
    "## Result\nRead-only review completed.\n\n## Summary\nKeep the recovery task in context.\n\n---\n\n## Design\nPreserve the original task."
  const trajectory =
    "## Execution Trajectory\n\n**Steps**: 5 | **Tool calls**: 13\n**Phases**: Skill(1 steps/1 calls) → Read(3 steps/12 calls)\n\n### Key Events\n\n★ **Step 5**: Content output (1,138 chars)\n   > ## Result Read-only review completed. ## Summary Keep the recovery task in context..."
  const output = trajectory + "\n\n---\n\n" + report
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate((output) => {
    const fixture = (window as unknown as { fixture: Fixture }).fixture
    fixture.event("agent-delivery")
    fixture.child("ctx_original", output, "summary")
  }, output)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolveEvent(1, "Original notification"),
  )
  const result = page.getByRole("tab", { name: "Result", exact: true })
  await result.waitFor()
  expect(await result.getAttribute("aria-selected")).toBe("true")
  await page.getByRole("heading", { name: "Summary", exact: true }).waitFor()
  expect(await page.getByRole("heading", { name: "Design", exact: true }).count()).toBe(1)
  expect(await page.locator('[data-component="markdown"] blockquote').count()).toBe(0)
  expect(await page.getByText("Execution Trajectory", { exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Copy result", exact: true }).click()
  expect((await inspect()).copied).toBe(report)
  await result.focus()
  await result.press("ArrowRight")
  const process = page.getByRole("tab", { name: "Execution process", exact: true })
  expect(await process.getAttribute("aria-selected")).toBe("true")
  expect(await page.locator('[data-slot="execution-trajectory"] pre').textContent()).toBe(trajectory)
  expect(await page.locator('[data-component="markdown"]').count()).toBe(0)
  await page.getByRole("button", { name: "Copy execution process", exact: true }).click()
  expect((await inspect()).copied).toBe(trajectory)
  await page.locator('[data-slot="execution-raw-output"] > summary').click()
  await page.getByRole("button", { name: "Copy original output", exact: true }).click()
  expect((await inspect()).copied).toBe(output)
  await process.focus()
  await process.press("ArrowLeft")
  await page.getByRole("heading", { name: "Summary", exact: true }).waitFor()
  expect(errors).toEqual([])
}, 30000)

test("compaction refresh preserves visible evidence and late event reads cannot replace the new selection", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.event("compaction"))
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolveEvent(1, "Captured summary"))
  await page.getByText("Captured summary", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.refreshEvent())
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 3)
  expect(await page.getByText("Captured summary", { exact: true }).count()).toBe(1)
  expect(await page.getByText("Loading tool result…", { exact: true }).count()).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.event("compaction", "new-event"))
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 4)
  expect((await inspect()).aborted[2]).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolveEvent(3, "Current summary"))
  await page.getByText("Current summary", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolveEvent(2, "Stale summary"))
  expect(await page.getByText("Stale summary", { exact: true }).count()).toBe(0)
  expect(await page.getByText("Captured summary", { exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
}, 30000)

test("retained historical results cannot cross a connection or Scope with the same message identity", async () => {
  for (const next of [
    { server: "server-b", scope: "scope-a" },
    { server: "server-a", scope: "scope-b" },
  ]) {
    await page.goto(base)
    await page.waitForFunction(() => Boolean((window as unknown as { fixture: Fixture }).fixture?.facts().requests))
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolve(0, "Original result"))
    await page.getByText("Original result", { exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.select("part-a"))
    expect((await inspect()).requests).toBe(1)
    await page.evaluate(
      (next) => (window as unknown as { fixture: Fixture }).fixture.switchOwner(next.server, next.scope),
      next,
    )
    await page.getByText("Loading tool result…", { exact: true }).waitFor()
    expect(await page.locator('[data-slot="execution-output"] pre').count()).toBe(0)
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolve(1, "Current result"))
    await page.getByText("Current result", { exact: true }).waitFor()
  }
  expect(errors).toEqual([])
}, 30_000)

test("late responses cannot replace another selection and closing releases rendering and pending reads", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.select("part-b"))
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
  expect((await inspect()).aborted[0]).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolve(1, "Selected result"))
  await page.getByText("Selected result", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolve(0, "Late result"))
  expect(await page.locator('[data-slot="execution-output"] pre').textContent()).toBe("Selected result")
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.close())
  expect(await page.locator("[data-component=execution-detail]").count()).toBe(0)
  expect(await page.locator('[data-component="execution-code-block"]').count()).toBe(0)

  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.switchOwner("server-a", "scope-a", "other-session"),
  )
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
  expect((await inspect()).aborted[0]).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.close())
  expect((await inspect()).aborted[1]).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolve(1, "Closed result"))
  expect(await page.locator('[data-slot="execution-output"] pre').count()).toBe(0)
  expect(errors).toEqual([])
}, 30_000)

test("search and object results use copyable JSON blocks without another result layout", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  const results = [
    { kind: "search" as const, value: { hits: [{ path: "src/example.ts", line: 7, text: "const needle = 42" }] } },
    { kind: "object" as const, value: [{ memoryId: "memory-a", memoryTitle: "Item A" }] },
  ]
  for (const [index, result] of results.entries()) {
    if (index) {
      await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.select("part-object"))
      await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
    }
    await page.evaluate(
      ({ index, result }) =>
        (window as unknown as { fixture: Fixture }).fixture.resolve(index, "protocol", {
          kind: result.kind,
          text: JSON.stringify(result.value),
        }),
      { index, result },
    )
    await page.locator('[data-slot="execution-output"] pre').waitFor()
    expect(JSON.parse((await page.locator('[data-slot="execution-output"] pre').textContent())!)).toEqual(result.value)
    await page.getByRole("button", { name: "Copy tool output", exact: true }).click()
    expect(JSON.parse((await inspect()).copied)).toEqual(result.value)
    expect(
      await page.locator('[data-slot="execution-search-results"], [data-component="tool-object-result"]').count(),
    ).toBe(0)
  }
  expect(errors).toEqual([])
}, 30_000)

test("a failed invocation copies its displayed error while diagnostics copy native parameters", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.fail(0, "File not found: /fixture.txt"))
  await page.getByText("File not found: /fixture.txt", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Copy tool output", exact: true }).click()
  expect((await inspect()).copied).toBe("File not found: /fixture.txt")
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  await page.getByRole("button", { name: "Copy tool input", exact: true }).click()
  expect(JSON.parse((await inspect()).copied)).toEqual({ filePath: "/fixture.txt" })
  expect(errors).toEqual([])
}, 30_000)

test("diagnostics label native input once and leave returned content in the result view", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolve(
      0,
      JSON.stringify({ filePath: "/fixture.txt", recordId: "created-object" }),
    ),
  )
  await page
    .getByText("Captured file content is unavailable for this invocation. The recorded tool output is shown below.", {
      exact: true,
    })
    .waitFor()
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  expect(await page.locator('[data-slot="execution-output"] pre').count()).toBe(0)
  await page.getByRole("heading", { name: "Tool input", exact: true }).waitFor()
  expect(await page.locator('[data-slot="execution-input"] pre').count()).toBe(1)
  expect(JSON.parse((await page.locator('[data-slot="execution-input"] pre').textContent())!)).toEqual({
    filePath: "/fixture.txt",
  })
  expect(await page.getByText("created-object", { exact: false }).count()).toBe(0)
  await page.getByRole("tab", { name: "Result", exact: true }).click()
  expect(await page.locator('[data-slot="execution-output"] pre').textContent()).toContain("created-object")
  expect(errors).toEqual([])
}, 30_000)

test("failed diagnostics distinguish the input from the error without mounting a second result renderer", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.fail(0, "File not found: /fixture.txt"))
  await page.getByText("File not found: /fixture.txt", { exact: true }).waitFor()
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  expect(await page.locator('[data-slot="execution-output"] pre').count()).toBe(0)
  await page.getByRole("heading", { name: "Error details", exact: true }).waitFor()
  expect(await page.locator('[data-slot="execution-error"] pre').textContent()).toBe("File not found: /fixture.txt")
  expect(errors).toEqual([])
}, 30_000)

test("an interrupted command labels its captured output without turning stdout into a lifecycle state", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolveCommand(
      0,
      { status: "interrupted", exitCode: null, signal: "SIGTERM" },
      "waiting\n",
      "AbortError: Turn stopped; the session is paused and awaiting an explicit continue",
    ),
  )
  await page.getByText("Interrupted", { exact: true }).waitFor()
  expect(await page.locator('[data-slot="execution-detail-heading"]').textContent()).not.toContain("Failed")
  await page.getByText("Command output", { exact: true }).waitFor()
  await page.getByText("Output captured before interruption", { exact: true }).waitFor()
  expect(await page.locator('[data-slot="execution-output"] pre').textContent()).toBe("waiting\n")
  expect(await page.locator('[data-slot="execution-detail-heading"]').textContent()).toContain("SIGTERM")
  await page.getByRole("button", { name: "Copy tool output", exact: true }).click()
  expect((await inspect()).copied).toBe("waiting\n")
  expect(errors).toEqual([])
}, 30_000)

test("command lifecycle follows the process record independently of tool receipt and output text", async () => {
  for (const scenario of [
    { status: "running", label: "Process is still running", error: "AbortError: Turn stopped" },
    { status: "failed", label: "Failed", exitCode: 7, signal: "SIGTERM" },
    { status: "completed", label: "Completed", exitCode: 0 },
    { status: "completed", label: "Failed", exitCode: 0, error: "Tool callback failed after process exit" },
  ] as const) {
    await page.goto(base)
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
    await page.evaluate(
      (scenario) =>
        (window as unknown as { fixture: Fixture }).fixture.resolveCommand(
          0,
          scenario,
          "waiting\n",
          "error" in scenario ? scenario.error : undefined,
        ),
      scenario,
    )
    await page.getByText(scenario.label, { exact: true }).waitFor()
    expect(await page.locator('[data-slot="execution-output"] pre').textContent()).toBe("waiting\n")
    expect(await page.getByText("Interrupted", { exact: true }).count()).toBe(0)
    expect(await page.getByText("Output captured before interruption", { exact: true }).count()).toBe(0)
  }
  expect(errors).toEqual([])
}, 30_000)

test("activity refresh keeps the selected result visible without replaying the panel loading state", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolveCommand(0, { status: "running" }, "waiting\n"),
  )
  const output = page.locator('[data-slot="execution-output"] pre')
  await output.waitFor()
  const initial = await output.elementHandle()
  for (const revision of [1, 2, 3]) {
    await page.evaluate((revision) => (window as unknown as { fixture: Fixture }).fixture.activity(revision), revision)
    await page.waitForFunction(
      (count) => (window as unknown as { fixture: Fixture }).fixture.facts().requests === count,
      revision + 1,
    )
    expect(await output.isVisible()).toBe(true)
    expect(await page.getByText("Loading tool result…", { exact: true }).count()).toBe(0)
    expect(await initial!.evaluate((element) => element.isConnected)).toBe(true)
    await page.evaluate(
      (index) =>
        (window as unknown as { fixture: Fixture }).fixture.resolveCommand(
          index,
          { status: "running" },
          `waiting\nstep ${index}\n`,
        ),
      revision,
    )
    await page.waitForFunction(
      (index) =>
        document.querySelector('[data-slot="execution-output"] pre')?.textContent === `waiting\nstep ${index}\n`,
      revision,
    )
  }
  expect(errors).toEqual([])
}, 30_000)

test("activity refresh preserves expanded output and the user's reading position", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  const content = "Captured output line\n".repeat(1200)
  await page.evaluate(
    (content) => (window as unknown as { fixture: Fixture }).fixture.resolveCommand(0, { status: "running" }, content),
    content,
  )
  await page.getByRole("button", { name: "Show full content", exact: true }).click()
  const body = page.locator('[data-slot="execution-detail-body"]')
  await body.evaluate((element) => {
    element.scrollTop = 280
  })
  await page.waitForFunction(() => document.querySelector('[data-slot="execution-detail-body"]')?.scrollTop === 280)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.activity(1))
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
  expect(await body.isVisible()).toBe(true)
  expect(await body.evaluate((element) => element.scrollTop)).toBe(280)
  expect(await page.locator('[data-slot="execution-output"] pre').textContent()).toBe(content)
  await page.evaluate(
    (content) => (window as unknown as { fixture: Fixture }).fixture.resolveCommand(1, { status: "running" }, content),
    content + "Next line\n",
  )
  await page.waitForFunction(
    (content) => document.querySelector('[data-slot="execution-output"] pre')?.textContent === content,
    content + "Next line\n",
  )
  expect(await body.evaluate((element) => element.scrollTop)).toBe(280)
  expect(await page.getByRole("button", { name: "Show full content", exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
}, 30_000)

test("new-message activity preserves historical selection and diagnostics focus", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.fail(0, "Captured error"))
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  const copy = page.getByRole("button", { name: "Copy tool input", exact: true })
  await copy.focus()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.select("part-a"))
  expect((await inspect()).requests).toBe(1)
  expect(
    await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).getAttribute("aria-selected"),
  ).toBe("true")
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.activity(1, "new-message"))
  expect((await inspect()).requests).toBe(1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.activity(2))
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
  expect(await copy.isVisible()).toBe(true)
  expect(await copy.evaluate((element) => document.activeElement === element)).toBe(true)
  expect(
    await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).getAttribute("aria-selected"),
  ).toBe("true")
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.fail(1, "Updated error"))
  await page.getByText("Updated error", { exact: true }).waitFor()
  expect(await copy.evaluate((element) => document.activeElement === element)).toBe(true)
  expect(errors).toEqual([])
}, 30_000)

test("the heading names the tool without repeating its command or input", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolveCommand(
      0,
      { status: "completed", exitCode: 0 },
      "waiting\n",
    ),
  )
  await page.getByRole("heading", { name: "bash", exact: true }).waitFor()
  expect(await page.locator('[data-slot="execution-detail-heading"]').textContent()).not.toContain("printf")
  expect(await page.getByText("Check the foreground wait command.", { exact: true }).count()).toBe(1)
  expect(await page.locator('[data-slot="execution-detail-toolbar"] button:not([role="tab"])').count()).toBe(0)
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  expect(JSON.parse((await page.locator('[data-slot="execution-input"] pre').textContent())!)).toEqual({
    command: "printf waiting && sleep 90",
  })
}, 30_000)

test("input and error are separate code blocks with independent keyboard copy actions", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.fail(0, "File not found: /fixture.txt"))
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).waitFor()
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  expect(await page.locator('[data-component="execution-code-block"]').count()).toBe(2)
  const inputCopy = page.getByRole("button", { name: "Copy tool input", exact: true })
  await inputCopy.focus()
  await page.keyboard.press("Enter")
  expect(JSON.parse((await inspect()).copied)).toEqual({ filePath: "/fixture.txt" })
  const errorCopy = page.getByRole("button", { name: "Copy error details", exact: true })
  await errorCopy.focus()
  await page.keyboard.press("Space")
  expect((await inspect()).copied).toBe("File not found: /fixture.txt")
  expect(await page.locator('[data-slot="execution-detail-toolbar"] button:not([role="tab"])').count()).toBe(0)
}, 30_000)

test("Markdown and JSON file reads keep raw bytes in the same copyable text presentation", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  for (const [index, result] of [
    { path: "/README.md", mediaType: "text/markdown", text: "# Message flow lab\n\nRun `python3 summarize.py`.\n" },
    { path: "/catalog.json", mediaType: "application/json", text: '[\n  { "title": "River", "price": 60 }\n]\n' },
  ].entries()) {
    if (index) {
      await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.select("part-json"))
      await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
    }
    await page.evaluate(
      ({ index, result }) =>
        (window as unknown as { fixture: Fixture }).fixture.resolve(index, "protocol", {
          kind: "file-read",
          ...result,
        }),
      { index, result },
    )
    await page.locator('[data-slot="execution-output"] pre').waitFor()
    expect(await page.locator('[data-slot="execution-output"] pre').textContent()).toBe(result.text)
    expect(await page.getByRole("button", { name: /^(Source|Preview)$/ }).count()).toBe(0)
    expect(await page.getByRole("heading", { name: "Message flow lab", exact: true }).count()).toBe(0)
    await page.getByRole("button", { name: "Copy tool output", exact: true }).click()
    expect((await inspect()).copied).toBe(result.text)
  }
}, 30_000)

test("large results have a bounded preview while copying retains the complete captured content", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  const content = "x".repeat(18000) + "\nlast line\n"
  await page.evaluate(
    (content) =>
      (window as unknown as { fixture: Fixture }).fixture.resolve(0, content, { kind: "file-read", text: content }),
    content,
  )
  await page.locator('[data-slot="execution-output"] pre').waitFor()
  expect((await page.locator('[data-slot="execution-output"] pre').textContent())!.length).toBe(16000)
  await page.getByRole("button", { name: "Copy tool output", exact: true }).click()
  expect((await inspect()).copied).toBe(content)
  await page.getByRole("button", { name: "Show full content", exact: true }).click()
  expect(await page.locator('[data-slot="execution-output"] pre').textContent()).toBe(content)
}, 30_000)

test("an empty captured output is explicit and never replaced by a fabricated result", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolveCommand(0, { status: "completed", exitCode: 0 }, ""),
  )
  await page.getByText("No output captured.", { exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Copy tool output", exact: true }).isEnabled()).toBe(false)
  expect(await page.locator('[data-slot="execution-output"] pre').count()).toBe(0)
}, 30_000)

test("dedicated media results remain available and are released with the detail panel", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolve(0, "Media preview", {
      kind: "media",
      text: "Recorded media output",
    }),
  )
  await page.getByText("Media preview", { exact: true }).waitFor()
  expect(await page.locator('[data-slot="execution-original"] pre').isVisible()).toBe(false)
  await page.locator('[data-slot="execution-raw-output"] > summary').click()
  await page.getByRole("button", { name: "Copy tool output", exact: true }).click()
  expect((await inspect()).copied).toBe("Recorded media output")
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  expect((await inspect()).resultUnmounts).toBe(1)
  expect(await page.getByText("Media preview", { exact: true }).count()).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.close())
  expect(await page.locator('[data-component="execution-code-block"]').count()).toBe(0)
}, 30_000)

test("task output shares the readable report while retaining the original tool receipt", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  const report = "## Review findings\nKeep the original task in context."
  const trajectory = "## Execution Trajectory\n\n**Steps**: 2 | **Tool calls**: 1\n\n**Phases**: Read(1 steps/1 calls)"
  await page.evaluate(
    ({ report, trajectory }) =>
      (window as unknown as { fixture: Fixture }).fixture.taskOutput(0, {
        mode: "summary",
        value: trajectory + "\n\n---\n\n" + report,
      }),
    { report, trajectory },
  )
  await page.getByRole("heading", { name: "Review findings", exact: true }).waitFor()
  expect(await page.locator('[data-slot="execution-detail-heading"]').textContent()).toContain("Task status: Failed")
  expect(await page.locator('[data-slot="execution-status"]').textContent()).toBe("Completed")
  await page.getByRole("button", { name: "Copy result", exact: true }).click()
  expect((await inspect()).copied).toBe(report)
  await page.getByRole("tab", { name: "Execution process", exact: true }).click()
  expect(await page.locator('[data-slot="execution-trajectory"] pre').textContent()).toBe(trajectory)
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  await page.locator('[data-slot="execution-raw-output"] > summary').click()
  await page.getByRole("button", { name: "Copy original output", exact: true }).click()
  expect((await inspect()).copied).toBe("Task receipt")
}, 30000)

test("task metadata never replaces progress reads or another task's result", async () => {
  for (const scenario of [
    { mode: "progress", taskID: "ctx_original" },
    { mode: "full", taskID: "ctx_other" },
  ]) {
    await page.goto(base)
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
    await page.evaluate(
      (scenario) =>
        (window as unknown as { fixture: Fixture }).fixture.taskOutput(
          0,
          { mode: "final_response", value: "Wrong report" },
          scenario.mode,
          scenario.taskID,
        ),
      scenario,
    )
    await page.getByText("Task receipt", { exact: true }).waitFor()
    expect(await page.getByText("Wrong report", { exact: true }).count()).toBe(0)
    expect(await page.getByRole("tab", { name: "Execution process", exact: true }).count()).toBe(0)
  }
}, 30000)

test("compaction uses the shared status header and keeps failure details in diagnostics", async () => {
  for (const scenario of [
    { state: "running", status: "Running" },
    { state: "committed", status: "Completed" },
    { state: "failed", status: "Failed" },
  ] as const) {
    await page.goto(base)
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.event("compaction"))
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
    await page.evaluate(
      (scenario) =>
        (window as unknown as { fixture: Fixture }).fixture.resolveEvent(
          1,
          "Recorded compaction evidence",
          scenario.state,
        ),
      scenario,
    )
    await page.locator('[data-slot="execution-status"]').getByText(scenario.status, { exact: true }).waitFor()
    await page.getByRole("tab", { name: "Diagnostics", exact: true }).waitFor()
    if (scenario.state === "failed") {
      expect(await page.getByText("Recorded compaction evidence", { exact: true }).count()).toBe(0)
      await page.getByRole("tab", { name: "Diagnostics", exact: true }).click()
      expect(await page.locator('[data-slot="execution-error"] pre').textContent()).toBe("Recorded compaction evidence")
    }
  }
}, 30000)

test("tool transport failure offers retry without losing accepted content or diagnostics focus", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.rejectEvent(0))
  const retry = page.getByRole("button", { name: "Retry loading content", exact: true })
  await retry.click()
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
  expect(await retry.isDisabled()).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolve(1, "Saved evidence"))
  await page.getByText("Saved evidence", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.activity(1))
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 3)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.rejectEvent(2))
  await retry.waitFor()
  expect(await page.getByText("Saved evidence", { exact: true }).count()).toBe(1)
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  const input = page.getByRole("button", { name: "Copy tool input", exact: true })
  await input.focus()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.activity(2))
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 4)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolve(3, "Refreshed evidence"))
  expect(await input.evaluate((el) => el === document.activeElement)).toBe(true)
  expect(errors).toEqual([])
}, 30000)

test("truncated evidence clearly limits expansion and copy to the loaded portion", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  const text = "captured line\n".repeat(2000)
  await page.evaluate(
    (text) =>
      (window as unknown as { fixture: Fixture }).fixture.resolve(0, text, {
        kind: "file-read",
        text,
        truncated: true,
      }),
    text,
  )
  await page
    .getByText("Only part of this output was loaded. Copy and expand apply to the loaded portion.", { exact: true })
    .waitFor()
  expect(await page.getByRole("button", { name: "Show full content", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Copy loaded output", exact: true }).click()
  expect((await inspect()).copied).toBe(text)
  await page.getByRole("button", { name: "Expand loaded portion", exact: true }).click()
  expect(await page.locator('[data-slot="execution-output"] pre').textContent()).toBe(text)
}, 30000)

test("file changes show one result and keep their tool receipt in diagnostics", async () => {
  for (const tool of ["edit", "revise_file", "apply_patch"]) {
    await page.goto(base)
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
    await page.evaluate(
      (tool) =>
        (window as unknown as { fixture: Fixture }).fixture.resolve(0, "Dedicated viewer", {
          kind: "file-change",
          text: "Diff receipt",
          tool,
        }),
      tool,
    )
    await page.getByText("Dedicated viewer", { exact: true }).waitFor()
    expect(await page.locator('[data-slot="execution-raw-output"]').count()).toBe(0)
    await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
    await page.getByRole("button", { name: "Copy tool output", exact: true }).click()
    expect((await inspect()).copied).toBe("Diff receipt")
    expect(await page.locator('[data-slot="execution-rich-result"]').count()).toBe(0)
  }
}, 30000)

test("plugin viewers precede collapsed raw output using the shared shell", async () => {
  for (const activity of [{ kind: "object", tool: "fixture.plugin", text: "Plugin receipt" }] as const) {
    await page.goto(base)
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
    await page.evaluate(
      (activity) => (window as unknown as { fixture: Fixture }).fixture.resolve(0, "Dedicated viewer", activity),
      activity,
    )
    await page.getByText("Dedicated viewer", { exact: true }).waitFor()
    expect(await page.locator('[data-slot="execution-original"] pre').isVisible()).toBe(false)
    await page.locator('[data-slot="execution-raw-output"] > summary').click()
    const rich = await page.locator('[data-slot="execution-rich-result"]').boundingBox()
    const raw = await page.locator('[data-slot="execution-original"]').boundingBox()
    expect(rich!.y + rich!.height).toBeLessThan(raw!.y)
    await page.getByRole("button", { name: "Copy tool output", exact: true }).click()
    expect((await inspect()).copied).toBe(activity.text)
  }
}, 30000)

test("failed patch invocations open their structured ledger without activity evidence", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.patch(0))
  await page.locator('[data-slot="execution-rich-result"]').waitFor()
  expect(await page.locator('[data-slot="execution-status"]').textContent()).toBe("Outcome unconfirmed")
  expect(await page.locator('[data-slot="execution-rich-result"]').textContent()).toContain("Patch outcome unconfirmed")
  expect(await page.locator('[data-slot="execution-raw-output"]').count()).toBe(0)
  expect(await page.getByText("Patch outcome unconfirmed", { exact: true }).count()).toBe(1)
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  expect(await page.locator('[data-slot="execution-error"]').textContent()).toContain("Patch outcome unconfirmed")
})

test("mechanical compaction retains a readable summary and puts its limitation in diagnostics", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.event("compaction"))
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolveEvent(
      1,
      "## Preserved context\nRead this summary.",
      "committed",
      true,
    ),
  )
  await page.getByRole("heading", { name: "Preserved context", exact: true }).waitFor()
  await page.getByRole("tab", { name: "Result", exact: true }).focus()
  await page.keyboard.press("End")
  await page
    .getByText("This summary was mechanically generated due to context limits. Some detail may be missing.", {
      exact: true,
    })
    .waitFor()
  expect(await page.getByText("No additional diagnostics were recorded.", { exact: true }).count()).toBe(0)
  await page.keyboard.press("Home")
  await page.getByRole("heading", { name: "Preserved context", exact: true }).waitFor()
}, 30000)

test("a restored owner-specific execution detail silently hides and stops reads when its owner disappears", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 1)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolve(0, '{"control":"private-note"}', {
      kind: "object",
      text: '{"control":"private-note"}',
      tool: "note_read",
    }),
  )
  await page.locator('[data-component="execution-detail"]').waitFor()
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features([]))
  await page.waitForTimeout(30)
  expect(await page.locator('[data-component="execution-detail"]').count()).toBe(0)
  expect(await page.getByText("private-note", { exact: false }).count()).toBe(0)
  expect((await inspect()).requests).toBe(1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.activity(2))
  expect((await inspect()).requests).toBe(1)
})

test("old execution replies cannot restore details across a same-URL feature epoch", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 1)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.features(undefined))
  await page.waitForTimeout(30)
  expect((await inspect()).aborted).toEqual([true])
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolve(0, "Old private output", {
      kind: "object",
      text: "Old private output",
      tool: "note_read",
    }),
  )
  expect(await page.getByText("Old private output", { exact: false }).count()).toBe(0)
  await page.evaluate(() => {
    const f = (window as unknown as { fixture: Fixture }).fixture
    f.required(["note"])
    f.features([])
  })
  expect((await inspect()).requests).toBe(1)
})

test("partial revisions keep their status and copyable metadata after result summaries are removed", async () => {
  await page.goto(base)
  await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
  await page.evaluate(() =>
    (window as unknown as { fixture: Fixture }).fixture.resolve(0, "Diff viewer", {
      kind: "file-change",
      tool: "revise_file",
      text: "Recorded receipt",
      metadata: {
        partialFailure: "File changed on disk",
        files: [{ file: "a.ts", preview: "raw patch must not repeat" }],
        diagnostics: { "a.ts": [{ message: "type error" }] },
        sections: [{ path: "a.ts", applied: true, filediff: { preview: "raw patch must not repeat" } }],
      },
    }),
  )
  await page.getByText("Partially applied", { exact: true }).waitFor({ timeout: 2000 })
  expect(await page.getByText("type error", { exact: true }).count()).toBe(0)
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  await page.getByRole("button", { name: "Copy execution details", exact: true }).click()
  const copied = JSON.parse((await inspect()).copied)
  expect(copied.partialFailure).toBe("File changed on disk")
  expect(copied.diagnostics["a.ts"][0].message).toBe("type error")
  expect(copied.sections).toEqual([{ path: "a.ts", applied: true }])
  expect((await inspect()).copied).not.toContain("raw patch must not repeat")
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

type Fixture = {
  event(kind: "agent-delivery" | "compaction", messageID?: string): void
  child(taskID: string, value: string): void
  resolveEvent(index: number, text: string, state?: "running" | "committed" | "failed"): void
  refreshEvent(): void
  switchOwner(server: string, scope: string, sessionID?: string): void
  select(partID: string): void
  activity(revision: number, messageID?: string): void
  resolve(
    index: number,
    output: string,
    activity?: { kind: "search" | "object" | "file-read" | "media"; text: string; mediaType?: string; path?: string },
  ): void
  fail(index: number, error: string): void
  resolveCommand(
    index: number,
    process: { status: "running" | "completed" | "interrupted" | "failed"; exitCode?: number | null; signal?: string },
    text: string,
    toolError?: string,
  ): void
  close(): void
  facts(): { requests: number; aborted: boolean[]; resultUnmounts: number; copied: string }
}
let server: ViteDevServer
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
    const requests=[]
    let activityListener
    let resultUnmounts=0
    let copied=""
    let child={taskID:"ctx_original",parentSessionID:"session",output:{mode:"final_response",value:"Saved child result"}}
    const [eventLive,setEventLive]=createSignal()
    configureClipboard({writer(text){copied=text}})
    const h=window.fixture={state,open,
      event(kind,messageID="event"){setState({...owner,kind,messageID})},
      child(taskID,value){child={taskID,parentSessionID:owner.sessionID,output:{mode:"final_response",value}}},
      resolveEvent(index,text,status="committed"){
        const request=requests[index]
        const info={id:request.messageID,sessionID:request.sessionID,role:request.kind==="compaction"?"assistant":"user",time:{created:1,completed:status==="running"?undefined:2},metadata:request.kind==="compaction"?{compactionAttempt:{state:status}}:undefined,origin:request.kind==="agent-delivery"?{type:"cortex",sessionID:"child",taskID:"ctx_original",label:"Evidence review"}:undefined,error:status==="failed"?{name:"UnknownError",data:{message:text}}:undefined}
        request.resolve({data:{info,parts:[{id:"event-part",messageID:info.id,sessionID:info.sessionID,type:request.kind==="compaction"&&status==="committed"?"compaction_recovery":"text",text,summary:request.kind==="compaction"?text:undefined,mechanical:false}]}})
      },
      refreshEvent(){setEventLive({id:state().messageID,time:{created:1,completed:3},metadata:{compactionAttempt:{state:"committed"}}})},
      switchOwner(server,scope,sessionID="session"){batch(()=>{setOwner({server,scope,sessionID});setState({...owner,messageID:"message",partID:"part-a",callID:"call-part-a"})})},
      select(partID){setState({...state(),partID,callID:"call-"+partID})},
      activity(revision,messageID="message"){activityListener?.({properties:{sessionID:owner.sessionID,messageID,callID:state().callID,revision}})},
      resolve(index,output,activity){const request=requests[index];request.resolve({data:{evidenceMissing:!activity,text:activity?.text,part:{id:request.partID,callID:request.callID,messageID:"message",sessionID:request.sessionID,type:"tool",tool:"read",activityEvidence:activity?{kind:activity.kind,mediaType:activity.mediaType??"application/json",resource:{path:activity.path},range:activity.kind==="file-read"?{startLine:0,lineCount:activity.text.split("\\n").length}:undefined}:undefined,state:{status:"completed",input:{filePath:"/fixture.txt"},output,time:{start:1,end:2}}}}})},
      fail(index,error){const request=requests[index];request.resolve({data:{evidenceMissing:true,part:{id:request.partID,callID:request.callID,messageID:"message",sessionID:request.sessionID,type:"tool",tool:"read",state:{status:"error",input:{filePath:"/fixture.txt"},error,time:{start:1,end:2}}}}})},
      resolveCommand(index,process,text,toolError){const request=requests[index];request.resolve({data:{evidenceMissing:false,text,process,part:{id:request.partID,callID:request.callID,messageID:"message",sessionID:request.sessionID,type:"tool",tool:"bash",workBrief:"Check the foreground wait command.",activityEvidence:{kind:"command"},state:{status:toolError?"error":"completed",input:{command:'printf waiting && sleep 90'},error:toolError,output:toolError?undefined:text,time:{start:1,end:33401}}}}})},
      close(){setOpen(false)},facts(){return {requests:requests.length,aborted:requests.map(request=>request.signal.aborted),resultUnmounts,copied}}
    }
    export {h}
    export const useSDK=()=>({get url(){return owner.server},get scopeKey(){return owner.scope},event:{on(type,listener){activityListener=listener;return()=>{activityListener=undefined}}},client:{session:{message:async(target,options)=>new Promise(resolve=>requests.push({...target,kind:state().kind,signal:options.signal,resolve})),get:async()=>({data:{cortex:child}}),toolActivity:async(target,options)=>new Promise(resolve=>requests.push({...target,partID:state().partID,signal:options.signal,resolve}))}}})
    export const useParams=()=>({get id(){return owner.sessionID}})
    export const useSessionDataView=()=>()=>({messagesFor:()=>eventLive()?[eventLive()]:[],partsFor:()=>[]})
    export const useData=()=>({navigateToSession(){}})
    export const useWorkbenchPanels=()=>({updateTab(id,patch){setState(patch.state)}})
    export const Button=props=><button {...props}>{props.children}</button>
    export const ToolResultBody=props=>{onCleanup(()=>resultUnmounts++);return <output data-result>{props.part.state.error??props.part.state.output}</output>}
    export const AttachmentGallery=()=>null
    export const resolveExternalToolRenderer=()=>undefined
    export const externalLookup=undefined
    export const externalLoadNotify=()=>0
    export const Icon=()=> <span/>
    export const Markdown=props=> <div data-markdown>{props.text}</div>
    export const compactionErrorText=error=>error?.data?.message
    export const ErrorCard=props=><div>{props.error}</div>
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
    import {h} from "./bridge"
    import {ExecutionDetailWorkbenchContent} from ${JSON.stringify(`/@fs/${appSrc}/components/workspace/tool-execution-detail.tsx`)}
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><Suspense fallback={<p>Loading tool result…</p>}><Show when={h.open()}><ExecutionDetailWorkbenchContent tab={{id:"detail",panelId:"execution-detail",state:h.state()}}/></Show></Suspense></I18nProvider>,document.getElementById("root"))
  `,
  )
  const bridge = path.join(fixture, "bridge.tsx")
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [solid()],
    resolve: {
      alias: Object.fromEntries(
        [
          ["@", appSrc],
          ...[
            "@/context/sdk",
            "@/context/session-data-view",
            "@/context/workbench",
            "@ericsanchezok/synergy-ui/context/data",
            "@solidjs/router",
            ...[
              "button",
              "icon",
              "markdown",
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
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [path.resolve(appSrc, "../../.."), fixture] } },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("agent notices read the exact task result and never substitute a reused child task", async () => {
  for (const task of ["ctx_original", "ctx_later"]) {
    await page.goto(base)
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture?.facts().requests === 1)
    await page.evaluate((task) => {
      const fixture = (window as unknown as { fixture: Fixture }).fixture
      fixture.event("agent-delivery")
      fixture.child(task, "Full original child result")
    }, task)
    await page.waitForFunction(() => (window as unknown as { fixture: Fixture }).fixture.facts().requests === 2)
    await page.evaluate(() =>
      (window as unknown as { fixture: Fixture }).fixture.resolveEvent(1, "Original notification"),
    )
    await page
      .getByText(task === "ctx_original" ? "Full original child result" : "Original notification", { exact: true })
      .waitFor()
    expect(
      await page
        .getByText(task === "ctx_original" ? "Original notification" : "Full original child result", { exact: true })
        .count(),
    ).toBe(0)
  }
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
  await page.getByRole("button", { name: "Copy tool output", exact: true }).click()
  expect((await inspect()).copied).toBe("Recorded media output")
  await page.getByRole("tab", { name: "Parameters and diagnostics", exact: true }).click()
  expect((await inspect()).resultUnmounts).toBe(1)
  expect(await page.getByText("Media preview", { exact: true }).count()).toBe(0)
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.close())
  expect(await page.locator('[data-component="execution-code-block"]').count()).toBe(0)
}, 30_000)

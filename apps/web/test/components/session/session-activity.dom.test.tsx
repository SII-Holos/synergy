import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"
import type { CortexTask, SessionCortexDelegation } from "@ericsanchezok/synergy-sdk/client"

type FooterFixture = {
  active(value: boolean): void
  mounted(value: boolean): void
  status(value: SessionCortexDelegation["status"]): void
  metadata(value: Partial<SessionCortexDelegation>): void
  owner(value: {
    server?: string
    scopeID?: string
    sessionID?: string
    parentSessionID?: string
    taskID?: string
  }): void
  retry(): void
  resolve(index: number, value: Partial<CortexTask>): void
  facts(): {
    requests: Array<{
      parameters: { taskID: string; parentSessionID: string; sessionID: string }
      server: string
      scopeID: string
      aborted: boolean
    }>
    cortex: SessionCortexDelegation
  }
}

let browser: Browser
let page: Page
let server: BrowserFixture
let fixture: string
let baseURL: string
const errors: string[] = []

beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".progress-fixture-"))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "runtime.ts"),
    `
    import { batch, createSignal } from "solid-js"
    import { createStore } from "solid-js/store"
    import { createSessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
    const query = new URLSearchParams(location.search)
    const [changes,setChanges]=createSignal(query.has("changes") ? {rootID:"cold-root",createdAt:1,summary:{diffs:[],diffState:{status:"live"},diffTotals:{files:300,additions:900,deletions:2},diffHasChanges:true,diffRevision:"one"}} : undefined)
    window.updateChanges=setChanges
    window.reviewRoots=[]
    const [status, setStatus] = createSignal(query.has("ended") ? undefined : { type: "busy" })
    const [childStatus, setChildStatus] = createSignal()
    const [ready, setReady] = createSignal(true)
    const [connected, setConnected] = createSignal(true)
    const [waiting, setWaiting] = createSignal(false)
    const [permission, setPermission] = createSignal(false)
    const [offer, setOffer] = createSignal(false)
    const [editing, setEditing] = createSignal(false)
    const [cancelFailure, setCancelFailure] = createSignal(false)
    const [currentSession, setCurrentSession] = createSignal("s1")
    const [footerActive, setFooterActive] = createSignal(!query.has("inactive"))
    const [footerMounted, setFooterMounted] = createSignal(true)
    const [footerStatus, setFooterStatus] = createSignal()
    const [footerOwner, setFooterOwner] = createStore({server:"server-a",scopeID:"scope-a"})
    const [footerSession, setFooterSession] = createStore({id:"ses_footer_child",parentID:"ses_footer_parent",cortex:{
      taskID:"ctx_footer",parentSessionID:"ses_footer_parent",parentMessageID:"msg_footer",agent:"developer",
      description:"Inspect the footer result",status:query.has("running")?"running":"completed",startedAt:1000,
      completedAt:query.has("running")?undefined:66123,model:{providerID:"fixture-provider",modelID:"fixture-model"},
    }})
    const footerRequests=[]
    window.footerFixture={
      active:setFooterActive,mounted:setFooterMounted,
      status(status){setFooterSession("cortex",{status,completedAt:status==="running"||status==="queued"?undefined:66123})},
      metadata(value){setFooterSession("cortex",value)},
      owner(value){batch(()=>{
        if(value.server!==undefined)setFooterOwner("server",value.server)
        if(value.scopeID!==undefined)setFooterOwner("scopeID",value.scopeID)
        if(value.sessionID!==undefined)setFooterSession("id",value.sessionID)
        if(value.parentSessionID!==undefined){setFooterSession("parentID",value.parentSessionID);setFooterSession("cortex","parentSessionID",value.parentSessionID)}
        if(value.taskID!==undefined)setFooterSession("cortex","taskID",value.taskID)
      })},
      retry(){setFooterStatus({type:"retry",attempt:2,message:"Retrying the child",next:0})},
      resolve(index,value){const request=footerRequests[index];request.resolve({data:{
        id:request.parameters.taskID,parentSessionID:request.parameters.parentSessionID,sessionID:request.parameters.sessionID,
        parentMessageID:"msg_footer",agent:"developer",description:"Inspect the footer result",prompt:"Private full task instructions ".repeat(1000),
        status:request.status,startedAt:1000,completedAt:66123,...value,
      }})},
      facts(){return {requests:footerRequests.map(request=>({parameters:request.parameters,server:request.server,scopeID:request.scopeID,aborted:request.signal.aborted})),cortex:JSON.parse(JSON.stringify(footerSession.cortex))}},
    }
    export { offer, editing, currentSession, footerActive, footerMounted, footerSession }
    const [data, setData] = createStore({
      session: [{ id: "s1" }, { id: "other-parent" }, { id: "attention-peer" }], todo: { s1: [
        { id: "one", content: "Inspect the request interaction and preserve every word of this naturally wrapping long task", status: query.has("completed") ? "completed" : "in_progress", priority: "high" },
        { id: "two", content: "Write the regression test", status: query.has("completed") ? "completed" : "pending", priority: "medium" },
        { id: "three", content: "Retired item", status: "cancelled", priority: "low" },
      ] }, dag: { s1: [
        { id: "a", content: "Prepare the fixture", status: query.has("completed") ? "completed" : query.has("blocked") ? "blocked" : query.has("failed") ? "failed" : "running", deps: [], session_id: "child" },
        { id: "b", content: "Verify the result", status: query.has("completed") ? "completed" : "pending", deps: ["a"] },
      ], "attention-peer": [{ id: "peer", content: "Peer blocker", status: "blocked", deps: [] }] }, message: {}, part: {}, session_diff: {},
    })
    const [tasks, setTasks] = createStore([
      { id: "task-a", sessionID: "child", parentSessionID: "s1", agent: "coding", description: "Prepare the fixture", status: "running", startedAt: Date.now() - 1000 },
      { id: "task-q", sessionID: "queued", parentSessionID: "s1", agent: "general", description: "Queued task", status: "queued", startedAt: Date.now() },
      { id: "other-task", sessionID: "other", parentSessionID: "other-parent", agent: "general", description: "Other session", status: "running", startedAt: Date.now() },
      { id: "peer-task", sessionID: "peer-child", parentSessionID: "attention-peer", agent: "coding", description: "Peer task", status: "running", startedAt: Date.now() - 1000 },
      { id: "peer-queued", sessionID: "peer-queued", parentSessionID: "attention-peer", agent: "general", description: "Peer queued", status: "queued", startedAt: Date.now() },
    ])
    window.navigation = []
    window.cancellations = []
    const runtime = { statusFor: (id) => id === footerSession.id ? footerStatus() : id === "s1" ? status() : id === "child" ? childStatus() : undefined, cortexTasks: () => tasks, questionsFor: (id) => waiting() && id === "child" ? [{ id: "q", sessionID: "child", questions: [] }] : [], permissionsFor: (id) => permission() && id === "child" ? [{ id: "p", sessionID: "child" }] : [] }
    export const useSessionDataView = () => () => createSessionDataView(data, runtime)
    export const useSDK = () => ({ connected,get url(){return footerOwner.server},get scopeKey(){return footerOwner.scopeID}, client: { cortex: {
      get:(parameters,options)=>new Promise((resolve,reject)=>footerRequests.push({parameters,signal:options.signal,resolve,reject,server:footerOwner.server,scopeID:footerOwner.scopeID,status:footerSession.cortex.status})),
      cancel: async ({ taskID }) => { window.cancellations.push(taskID); if (cancelFailure()) throw new Error("Temporary cancellation failure"); return { data: true } }
    } } })
    export const useSync = () => ({session:{currentTurn:()=>changes()}, get ready() { return ready() } })
    export const useLocale = () => ({ i18n: window.fixtureI18n })
    export const useNavigate = () => (url) => { window.navigation = url }
    export const useNavigateToSession = () => (id) => { window.navigation.push(id) }
    export const useParams = () => ({ dir: "fixture" })
    window.changeProgress = (action) => {
      if (action === "idle" || action === "busy" || action === "paused" || action === "retry") setStatus(action === "idle" ? undefined : { type: action })
      if (action === "ready") setReady(true)
      if (action === "persisted-work") setData("session", 0, "working", { status: "busy" })
      if (action === "persisted-idle") setData("session", 0, "working", undefined)
      if (action === "disconnect") setConnected(false)
      if (action === "connect") setConnected(true)
      if (action === "wait") setWaiting(true)
      if (action === "answer") setWaiting(false)
      if (action === "permission") setPermission(true)
      if (action === "allow") setPermission(false)
      if (action === "offer") setOffer(true)
      if (action === "dismiss-offer") setOffer(false)
      if (action === "expand-editor") setEditing(true)
      if (action === "collapse-editor") setEditing(false)
      if (action === "cancel-failure") setCancelFailure(true)
      if (action === "cancel-success") setCancelFailure(false)
      if (action === "child-ended") setTasks(0, "status", "completed")
      if (action === "children-ended") { setTasks(task => task.parentSessionID === "s1", "status", "completed"); setChildStatus(undefined) }
      if (action === "child-busy") setChildStatus({ type: "busy" })
      if (action === "child-paused") setChildStatus({ type: "paused" })
      if (action === "switch-session") setCurrentSession("other-parent")
      if (action === "switch-back") setCurrentSession("s1")
      if (action === "switch-peer") setCurrentSession("attention-peer")
      if (action === "blocked") setData("dag", "s1", 0, "status", "blocked")
      if (action === "mixed") { setData("dag", "s1", 0, "status", "failed"); setData("dag", "s1", 1, "status", "blocked") }
      if (action === "resolved" || action === "cancelled" || action === "pending") setData("dag", "s1", 0, "status", action === "resolved" ? "completed" : action)
      if (action === "clear-dag") setData("dag", "s1", [])
      if (action === "clear-todo") setData("todo", "s1", [])
      if (action === "complete-dag") setData("dag", "s1", () => true, "status", "completed")
      if (action === "complete" || action === "cancel-all") {
        setData("dag", "s1", () => true, "status", action === "complete" ? "completed" : "cancelled")
        setData("todo", "s1", item => item.status !== "cancelled", "status", action === "complete" ? "completed" : "cancelled")
      }
      if (action === "memo") setData("dag", "s1", 0, "memo", "Completion details updated")
      if (action === "new-dag") setData("dag", "s1", [{ id: "new", content: "New task", status: "pending", deps: [] }])
      if (action === "reopen-todo") setData("todo", "s1", 0, "status", "in_progress")
      if (action === "todo-complete") setData("todo", "s1", item => item.status !== "cancelled", "status", "completed")
      if (action === "unknown") { setReady(false); setStatus(undefined) }
      if (action === "many") setTasks(Array.from({ length: 30 }, (_, i) => ({ ...tasks[0], id: "task-" + i, sessionID: "child-" + i, startedAt: Date.now() + i })))
      if (action === "failed") setData("dag", "s1", 0, "status", "failed")
      if (action === "large") setData("dag", "s1", Array.from({ length: 400 }, (_, i) => ({ id: "a" + i, content: "Task " + i, status: "pending", deps: i ? ["a" + (i - 1)] : [] })))
    }
  `,
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { Show } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { setupI18n } from "@lingui/core"
    import { messages as chineseMessages } from "@/locales/zh-CN/messages.po"
    import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
    import { PromptDockFloatLayer } from "@/components/session/prompt-dock-float-layer"
    import { offer, editing, currentSession, footerActive, footerMounted, footerSession } from "./runtime"
    import { SubagentSessionFooter } from "@/components/session/subagent-session-footer"
    import { useSessionMeta } from "@/composables/use-session-meta"
    import { ViewActivityProvider } from "@/context/view-residency"
    import { SessionSurfaceFocusProvider } from "@/components/session/session-surface-focus"
    import { DagGraph } from "@ericsanchezok/synergy-ui/dag-graph"
    import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
    import { Dialog } from "@kobalte/core/dialog"
    import { Toast } from "@ericsanchezok/synergy-ui/toast"
    import "@ericsanchezok/synergy-ui/styles"
    import "@/index.css"
    const chinese = new URLSearchParams(location.search).has("chinese")
    window.fixtureI18n = setupI18n({ locale: chinese ? "zh-CN" : "en", messages: chinese ? { "zh-CN": chineseMessages } : {} })
    function Footer(){
      const meta=useSessionMeta(()=>footerSession,()=>true)
      return <Show when={footerMounted()}><ViewActivityProvider active={footerActive}><section data-footer hidden={!footerActive()}>
        <SubagentSessionFooter cortex={meta().cortex} sessionID={footerSession.id} parentSessionID={meta().parentID??undefined}/>
      </section></ViewActivityProvider></Show>
    }
    render(() => <I18nProvider i18n={window.fixtureI18n}><ThemeProvider><MarkedProvider>
      <SessionSurfaceFocusProvider value={() => document.querySelector("#composer").focus()}>
        {new URLSearchParams(location.search).has("existingModal") ? <Dialog open><Dialog.Content aria-label="Existing modal"><button>Existing modal action</button></Dialog.Content></Dialog> : null}
        <div class="session-prompt-dock-content" style={{ position: "relative", width: "100%", "max-width": new URLSearchParams(location.search).has("wide") ? "1200px" : "720px", margin: new URLSearchParams(location.search).has("compressed") ? "48px auto 0" : new URLSearchParams(location.search).has("limitedDag") ? "240px auto 0" : new URLSearchParams(location.search).has("nearTop") ? "140px auto 0" : "420px auto 0" }}>
          {new URLSearchParams(location.search).has("selectionOnly") ? <DagGraph nodes={[{ id: "select", content: "Select task", status: "pending", deps: [] }]} enableInspector={false} onSelectNode={(node) => { (window.selectedNodes ??= []).push(node.id) }} /> : <PromptDockFloatLayer onReview={rootID=>window.reviewRoots.push(rootID)} sessionID={currentSession()} priorityControl={offer() ? <button data-offer>Review workflow</button> : undefined} />}
          <textarea id="composer" class="session-composer" data-expanded={editing() ? "" : undefined} aria-label="Composer" style={{ position: "relative", "z-index": 1, width: "100%", height: "160px" }} />
        </div>
        <Toast.Region />
        {new URLSearchParams(location.search).has("footer") ? <Footer/> : null}
      </SessionSurfaceFocusProvider>
    </MarkedProvider></ThemeProvider></I18nProvider>, document.getElementById("root"))
  `,
  )
  const runtime = path.join(fixture, "runtime.ts")
  server = await createBrowserFixture({
    root: fixture,
    styled: true,
    aliases: [
      ...["locale", "sdk", "sync", "session-data-view"].map((name) => ["@/context/" + name, runtime]),
      ["@/composables/use-navigate-to-session", runtime],
      ["@solidjs/router", runtime],
      ["@", path.resolve(import.meta.dir, "../../../src")],
    ].map(([find, replacement]) => ({ find, replacement })),
  })
  baseURL = server.url
  browser = await chromium.launch({ headless: true })
}, 60000)

beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 700 } })
  page.setDefaultTimeout(8000)
  errors.length = 0
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(baseURL)
  await page.locator("#composer").waitFor()
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})
afterEach(async () => {
  expect(errors).toEqual([])
  await page?.close()
})
const change = (action: string) =>
  page.evaluate((value) => (window as unknown as { changeProgress(value: string): void }).changeProgress(value), action)

const footerFacts = () =>
  page.evaluate(() => (window as unknown as { footerFixture: FooterFixture }).footerFixture.facts())
const waitForFooterReads = (count: number) =>
  page.waitForFunction(
    (count) => (window as unknown as { footerFixture: FooterFixture }).footerFixture.facts().requests.length === count,
    count,
  )
const resolveFooter = (index: number, value: Partial<CortexTask>) =>
  page.evaluate(
    ({ index, value }) => (window as unknown as { footerFixture: FooterFixture }).footerFixture.resolve(index, value),
    { index, value },
  )

test("terminal footer restores final, summary, structured and error previews from public Session summaries", async () => {
  const longResult = "Long footer result remains bounded. ".repeat(40)
  for (const scenario of [
    {
      status: "completed",
      value: { output: { mode: "final_response", value: "The final footer result remains available." } },
      preview: "The final footer result remains available.",
    },
    {
      status: "interrupted",
      value: {
        output: {
          mode: "summary",
          value:
            "## Execution Trajectory\n\n**Steps**: 2 | **Tool calls**: 1\n\n**Phases**: Read\n\nDetailed tool evidence must not become the footer preview.\n\n---\n\n## Result\n\nThe authored summary result remains available.",
        },
      },
      preview: "The authored summary result remains available.",
    },
    {
      status: "cancelled",
      value: { output: { mode: "structured", value: { finding: "The structured footer result remains available." } } },
      preview: '"finding": "The structured footer result remains available."',
    },
    {
      status: "error",
      value: {
        error: "The task failed while checking the footer result.",
        output: { mode: "final_response", value: "Do not replace the recorded failure with output." },
      },
      preview: "The task failed while checking the footer result.",
    },
    {
      status: "completed",
      value: { output: { mode: "final_response", value: longResult } },
      preview: longResult.slice(0, 117) + "...",
    },
  ] satisfies Array<{ status: SessionCortexDelegation["status"]; value: Partial<CortexTask>; preview: string }>) {
    await page.goto(baseURL + "?footer&running")
    await page.evaluate(
      (status) => (window as unknown as { footerFixture: FooterFixture }).footerFixture.status(status),
      scenario.status,
    )
    await waitForFooterReads(1)
    const before = await footerFacts()
    expect(before.cortex).not.toHaveProperty("output")
    expect(before.cortex).not.toHaveProperty("error")
    expect(before.requests[0].parameters).toEqual({
      taskID: "ctx_footer",
      parentSessionID: "ses_footer_parent",
      sessionID: "ses_footer_child",
    })
    await resolveFooter(0, scenario.value)
    const preview = page.locator('[data-footer] [data-slot="subagent-result-preview"]')
    await preview.waitFor()
    expect(await preview.textContent()).toBe(scenario.preview)
    expect((await preview.textContent())!.length).toBeLessThanOrEqual(120)
    expect((await footerFacts()).cortex).toEqual(before.cortex)
    expect(await page.locator("[data-footer]").getByTitle("fixture-provider/fixture-model").count()).toBe(1)
    expect(await page.locator("[data-footer]").getByText("1m 5s", { exact: true }).count()).toBe(1)
    await page.locator("[data-footer]").getByRole("button", { name: "Parent", exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as { navigation: string[] }).navigation)).toEqual([
      "ses_footer_parent",
    ])
  }
})

test("footer rejects mismatched, hidden or nonterminal details and preserves its model and status metadata", async () => {
  for (const mismatch of [
    { id: "ctx_other" },
    { parentSessionID: "ses_other_parent" },
    { sessionID: "ses_other_child" },
    { visibility: "hidden" },
    { status: "queued" },
    { status: "running" },
  ] satisfies Partial<CortexTask>[]) {
    await page.goto(baseURL + "?footer")
    await waitForFooterReads(1)
    await resolveFooter(0, {
      ...mismatch,
      output: { mode: "final_response", value: "Sensitive result from a different task owner." },
    })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await page.locator('[data-footer] [data-slot="subagent-result-preview"]').count()).toBe(0)
    expect(await page.locator("[data-footer]").getByText("Completed", { exact: true }).count()).toBe(1)
    await page.evaluate(() => {
      const fixture = (window as unknown as { footerFixture: FooterFixture }).footerFixture
      fixture.retry()
      fixture.metadata({ agent: "codex" })
    })
    await page.locator("[data-footer]").getByText("Retry #2", { exact: true }).waitFor()
    expect(await page.locator("[data-footer]").getByTitle("fixture-provider/fixture-model").count()).toBe(0)
    expect((await footerFacts()).requests).toHaveLength(1)
  }
})

test("footer reads only an active terminal child, cancels hidden reads and never polls", async () => {
  await page.goto(baseURL + "?footer&running&inactive")
  await page.waitForTimeout(1100)
  expect((await footerFacts()).requests).toHaveLength(0)
  await page.evaluate(() => (window as unknown as { footerFixture: FooterFixture }).footerFixture.active(true))
  await page.locator("[data-footer]").getByText("Running", { exact: true }).waitFor()
  await page.waitForTimeout(1100)
  expect((await footerFacts()).requests).toHaveLength(0)
  await page.evaluate(() => (window as unknown as { footerFixture: FooterFixture }).footerFixture.status("completed"))
  await waitForFooterReads(1)
  await resolveFooter(0, { output: { mode: "final_response", value: "The active child result is available." } })
  await page.getByText("The active child result is available.", { exact: true }).waitFor()
  await page.evaluate(() =>
    (window as unknown as { footerFixture: FooterFixture }).footerFixture.metadata({
      description: "Updated public description only",
    }),
  )
  await page.waitForTimeout(1100)
  expect((await footerFacts()).requests).toHaveLength(1)
  await page.evaluate(() => {
    const fixture = (window as unknown as { footerFixture: FooterFixture }).footerFixture
    fixture.active(false)
    fixture.status("error")
  })
  expect(await page.locator('[data-footer] [data-slot="subagent-result-preview"]').count()).toBe(0)
  expect((await footerFacts()).requests).toHaveLength(1)
  await page.evaluate(() => (window as unknown as { footerFixture: FooterFixture }).footerFixture.active(true))
  await waitForFooterReads(2)
  await page.evaluate(() => (window as unknown as { footerFixture: FooterFixture }).footerFixture.active(false))
  expect((await footerFacts()).requests[1].aborted).toBe(true)
  await resolveFooter(1, { error: "A hidden reply must never become visible." })
  expect(await page.locator('[data-footer] [data-slot="subagent-result-preview"]').count()).toBe(0)
  await page.evaluate(() => (window as unknown as { footerFixture: FooterFixture }).footerFixture.active(true))
  await waitForFooterReads(3)
  await resolveFooter(2, { error: "The resumed child failure remains available." })
  await page.getByText("The resumed child failure remains available.", { exact: true }).waitFor()
  await page.evaluate(() =>
    (window as unknown as { footerFixture: FooterFixture }).footerFixture.metadata({ visibility: "hidden" }),
  )
  expect(await page.locator('[data-footer] [data-slot="subagent-result-preview"]').count()).toBe(0)
  await page.waitForTimeout(1100)
  expect((await footerFacts()).requests).toHaveLength(3)
})

test("late footer replies cannot cross server, Scope, parent, child, task identity or unmount", async () => {
  for (const owner of [
    { server: "server-b" },
    { scopeID: "scope-b" },
    { parentSessionID: "ses_footer_other_parent" },
    { sessionID: "ses_footer_other" },
    { taskID: "ctx_footer_other" },
  ]) {
    await page.goto(baseURL + "?footer")
    await waitForFooterReads(1)
    await page.evaluate(
      (owner) => (window as unknown as { footerFixture: FooterFixture }).footerFixture.owner(owner),
      owner,
    )
    await waitForFooterReads(2)
    expect((await footerFacts()).requests[0].aborted).toBe(true)
    await resolveFooter(1, { output: { mode: "final_response", value: "The current owner result remains visible." } })
    await page.getByText("The current owner result remains visible.", { exact: true }).waitFor()
    await resolveFooter(0, { output: { mode: "final_response", value: "The stale owner result must never appear." } })
    expect(await page.getByText("The stale owner result must never appear.", { exact: true }).count()).toBe(0)
    expect(await page.getByText("The current owner result remains visible.", { exact: true }).count()).toBe(1)
  }
  await page.goto(baseURL + "?footer")
  await waitForFooterReads(1)
  await page.evaluate(() => (window as unknown as { footerFixture: FooterFixture }).footerFixture.mounted(false))
  expect((await footerFacts()).requests[0].aborted).toBe(true)
  await resolveFooter(0, { error: "The disposed footer must not retain this response." })
  expect(await page.locator("[data-footer]").count()).toBe(0)
  await page.evaluate(() => (window as unknown as { footerFixture: FooterFixture }).footerFixture.mounted(true))
  await waitForFooterReads(2)
  await resolveFooter(1, { output: { mode: "final_response", value: "The reopened footer reads a fresh result." } })
  await page.getByText("The reopened footer reads a fresh result.", { exact: true }).waitFor()
})
const expand = () => page.locator(".session-progress-island-header").click()

test("the bottom dock mounts current agents and expandable Todo and DAG", async () => {
  await page.locator(".subagent-dock-avatar").first().waitFor()
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(2)
  await expand()
  expect(await page.locator(".session-progress-todo-row").count()).toBe(3)
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.getByRole("button", { name: "Task: Prepare the fixture", exact: true }).waitFor()
})

const navigation = () => page.evaluate(() => (window as unknown as { navigation: string[] }).navigation)
const cancellations = () => page.evaluate(() => (window as unknown as { cancellations: string[] }).cancellations)
const avatar = () => page.locator(".subagent-dock-avatar").first()
async function holdPointer() {
  const box = (await avatar().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
}

test("short activation opens the child while queued agents remain waiting", async () => {
  await avatar().click()
  await avatar().press("Enter")
  await avatar().press("Space")
  await page.locator(".subagent-dock-avatar").last().dispatchEvent("click")
  expect(await navigation()).toEqual(["child", "child", "child"])
  expect(await cancellations()).toEqual([])
})

test("pointer and keyboard holds cancel once and preserve focus without opening the child", async () => {
  await page.clock.install()
  await holdPointer()
  await page.clock.runFor(2100)
  await page.mouse.up()
  await avatar().press("Enter")
  await page.clock.runFor(2100)
  expect(await cancellations()).toEqual(["task-a"])
  expect(await navigation()).toEqual([])
  expect(await avatar().getAttribute("aria-busy")).toBe("true")
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(2)
  await change("child-ended")
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(1)
  expect(
    await page.getByRole("textbox", { name: "Composer" }).evaluate((element) => element === document.activeElement),
  ).toBe(true)
  await page.reload()
  await avatar().focus()
  await page.keyboard.down("Space")
  await page.clock.runFor(2100)
  await page.keyboard.up("Space")
  expect(await cancellations()).toEqual(["task-a"])
  expect(await navigation()).toEqual([])
  await change("child-ended")
  expect(
    await page.getByRole("textbox", { name: "Composer" }).evaluate((element) => element === document.activeElement),
  ).toBe(true)
  await page.reload()
  await page.locator(".session-progress-island-header").focus()
  await change("child-ended")
  expect(
    await page.locator(".session-progress-island-header").evaluate((element) => element === document.activeElement),
  ).toBe(true)
})

test("movement, pointer cancellation, blur and Escape abort hold activation", async () => {
  await page.clock.install()
  await holdPointer()
  await page.mouse.move(10, 10, { steps: 4 })
  await page.clock.runFor(2200)
  await page.mouse.up()
  await holdPointer()
  await avatar().dispatchEvent("pointercancel", { pointerId: 1 })
  await page.clock.runFor(2200)
  await page.mouse.up()
  await holdPointer()
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  await page.clock.runFor(2200)
  await page.mouse.up()
  await avatar().focus()
  await page.keyboard.down("Space")
  await page.keyboard.press("Escape")
  await page.clock.runFor(2200)
  await page.keyboard.up("Space")
  expect(await cancellations()).toEqual([])
  expect(await navigation()).toEqual([])
  await avatar().click()
  expect(await navigation()).toEqual(["child"])
})

test("expanded editing aborts a hold and retains the collapsed graph and pending cancellation", async () => {
  await page.clock.install()
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.locator('[data-component="dag-graph"]').evaluate((element) => {
    ;(window as unknown as { retained: Element }).retained = element
  })
  await holdPointer()
  await change("expand-editor")
  await page.clock.runFor(2200)
  await page.mouse.up()
  expect(await cancellations()).toEqual([])
  expect(await navigation()).toEqual([])
  expect(await avatar().isVisible()).toBe(false)
  expect(await page.locator(".session-progress-island-header").isVisible()).toBe(false)
  await change("collapse-editor")
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("false")
  await expand()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((element) => element === (window as unknown as { retained: Element }).retained),
  ).toBe(true)
  await holdPointer()
  await page.clock.runFor(2100)
  await page.mouse.up()
  await change("expand-editor")
  await change("collapse-editor")
  expect(await avatar().getAttribute("aria-busy")).toBe("true")
  await avatar().press("Enter")
  expect(await cancellations()).toEqual(["task-a"])
  expect(await navigation()).toEqual([])
})

test("secondary pointer cancellation cannot interrupt the initiating hold", async () => {
  await page.clock.install()
  await holdPointer()
  await avatar().dispatchEvent("pointercancel", { pointerId: 2, pointerType: "touch", isPrimary: false })
  await avatar().dispatchEvent("lostpointercapture", { pointerId: 2, pointerType: "touch", isPrimary: false })
  await page.clock.runFor(2100)
  await page.mouse.up()
  expect(await cancellations()).toEqual(["task-a"])
  expect(await navigation()).toEqual([])
})

test("failed cancellation explains the error and permits another attempt", async () => {
  await change("cancel-failure")
  await holdPointer()
  await page.waitForFunction(() => (window as unknown as { cancellations: string[] }).cancellations.length === 1)
  await page.mouse.up()
  await page.getByText("Could not cancel agent", { exact: true }).waitFor()
  expect(await avatar().getAttribute("aria-busy")).toBe("false")
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(2)
  expect(await navigation()).toEqual([])
  await change("cancel-success")
  await holdPointer()
  await page.waitForFunction(() => (window as unknown as { cancellations: string[] }).cancellations.length === 2)
  await page.mouse.up()
  expect(await cancellations()).toEqual(["task-a", "task-a"])
})

test("changing session during a hold discards the old gesture", async () => {
  await page.clock.install()
  await holdPointer()
  await change("switch-session")
  await page.clock.runFor(2200)
  await page.mouse.up()
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(1)
  expect(await cancellations()).toEqual([])
  expect(await navigation()).toEqual([])
})

test("many agents remain reachable in an initially narrow viewport without horizontal page overflow", async () => {
  await page.setViewportSize({ width: 320, height: 700 })
  await page.reload()
  await page.locator("#composer").waitFor()
  await change("many")
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(30)
  await page.locator(".subagent-dock-avatar").last().focus()
  await page.keyboard.press("Enter")
  expect(await navigation()).toEqual(["child-29"])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test("workflow priority hides progress and freezes its retained DAG without removing avatars", async () => {
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.locator('[data-component="dag-graph"]').evaluate((element) => {
    ;(window as unknown as { retained: Element }).retained = element
  })
  await page.getByRole("button", { name: "Fit", exact: true }).focus()
  await change("offer")
  expect(await page.locator("[data-offer]").isVisible()).toBe(true)
  expect(await page.locator(".session-progress-island-header").isVisible()).toBe(false)
  expect(await page.locator(".subagent-dock-avatar").count()).toBe(2)
  expect(
    await page.getByRole("textbox", { name: "Composer" }).evaluate((element) => element === document.activeElement),
  ).toBe(true)
  await change("dismiss-offer")
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("false")
  await expand()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((element) => element === (window as unknown as { retained: Element }).retained),
  ).toBe(true)
})

test("unfinished work survives child decisions and unknown execution without claiming activity", async () => {
  await page.clock.install()
  await change("permission")
  await change("idle")
  await page.clock.runFor(2200)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  expect(await page.locator(".session-progress-island-title").textContent()).toContain("Waiting for you")
  await change("allow")
  await page.clock.runFor(1000)
  await change("unknown")
  await page.clock.runFor(2200)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-label")).toContain("Status unknown")
  await change("idle")
  await change("ready")
  await page.clock.runFor(1800)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
})

test("compressed space opens a readable progress dialog and restores focus on close", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  await page.goto(`${baseURL}?compressed`)
  await expand()
  const dialog = page.getByRole("dialog", { name: "Session progress", exact: true })
  await dialog.waitFor()
  await page.waitForFunction(() => document.activeElement?.classList.contains("session-progress-island-close"))
  const box = (await dialog.boundingBox())!
  expect(box.height).toBeGreaterThan(150)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(430)
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.getByRole("button", { name: "Task: Prepare the fixture", exact: true }).click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
  await page.keyboard.press("Escape")
  await page.locator('[data-slot="dag-node-preview"]').waitFor({ state: "detached" })
  expect(await dialog.isVisible()).toBe(true)
  await page.locator('[data-component="dag-graph"]').evaluate((element) => {
    ;(window as unknown as { compactGraph: Element }).compactGraph = element
  })
  await page.getByRole("button", { name: "Close progress", exact: true }).click()
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("false")
  await page.waitForFunction(() => document.activeElement?.classList.contains("session-progress-island-header"))
  await expand()
  await dialog.waitFor()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((element) => element === (window as unknown as { compactGraph: Element }).compactGraph),
  ).toBe(true)
  const zoom = await page.context().newCDPSession(page)
  await zoom.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 })
  await page.waitForFunction(() => {
    const rect = document.querySelector('.session-progress-island-panel[data-expanded="true"]')?.getBoundingClientRect()
    const viewport = window.visualViewport!
    return rect && rect.top >= viewport.offsetTop && rect.bottom <= viewport.offsetTop + viewport.height
  })
  expect(await page.evaluate(() => visualViewport!.scale)).toBe(2)
  await page.waitForFunction(() => {
    const graph = document.querySelector('[data-component="dag-graph"]')!.getBoundingClientRect()
    const body = document.querySelector(".session-progress-island-body")!.getBoundingClientRect()
    return graph.top >= body.top && graph.bottom <= body.bottom
  })
  await zoom.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 })
})

test("completion preserves an expanded dialog until the reader closes it, then releases focus", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  await page.goto(`${baseURL}?compressed`)
  await page.clock.install()
  await expand()
  await page.getByRole("button", { name: "Close progress", exact: true }).focus()
  await change("complete")
  await page.clock.runFor(5000)
  expect(await page.getByRole("dialog", { name: "Session progress", exact: true }).isVisible()).toBe(true)
  expect(
    await page
      .getByRole("button", { name: "Close progress", exact: true })
      .evaluate((node) => node === document.activeElement),
  ).toBe(true)
  await page.getByRole("button", { name: "Close progress", exact: true }).click()
  await page.clock.runFor(1800)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
  expect(
    await page.getByRole("textbox", { name: "Composer" }).evaluate((element) => element === document.activeElement),
  ).toBe(true)
})

test("collapsed progress cannot suspend an existing modal focus boundary", async () => {
  await page.goto(`${baseURL}?existingModal`)
  const action = page.getByRole("button", { name: "Existing modal action", exact: true })
  await action.focus()
  await page.keyboard.press("Tab")
  expect(
    await page
      .getByRole("dialog", { name: "Existing modal", exact: true })
      .evaluate((element) => element.contains(document.activeElement)),
  ).toBe(true)
})

test("a constrained DAG keeps the active task visible in the actual reading body", async () => {
  await page.goto(`${baseURL}?limitedDag`)
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  const nodes = page.locator('[data-slot="dag-graph-node-action"]')
  await nodes.first().waitFor()
  expect(await nodes.count()).toBe(2)
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-slot="dag-graph-node-action"]')].some((element) => {
      if (element.getAttribute("aria-label") !== "Task: Prepare the fixture") return false
      const rect = element.getBoundingClientRect()
      const body = element.closest(".session-progress-island-body")!.getBoundingClientRect()
      return (
        rect.top >= body.top &&
        rect.bottom <= body.bottom &&
        document
          .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          ?.closest('[data-slot="dag-graph-node-action"]') === element
      )
    }),
  )
  await page.getByRole("button", { name: "Task: Prepare the fixture", exact: true }).click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
})

test("progress stays inside a short viewport when a request pushes its anchor near the top", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  await page.goto(`${baseURL}?nearTop`)
  await expand()
  const panel = page.locator(".session-progress-island-panel")
  await page.waitForFunction(
    () => {
      const rect = document.querySelector(".session-progress-island-panel")?.getBoundingClientRect()
      return rect && rect.top >= 0 && rect.bottom <= innerHeight
    },
    undefined,
    { timeout: 4000 },
  )
  const bounds = (await panel.boundingBox())!
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(430)
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(375)
  expect(
    await panel.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return !!document
        .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        ?.closest(".session-progress-island-panel")
    }),
  ).toBe(true)
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.getByRole("button", { name: "Task: Prepare the fixture", exact: true }).click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
})

test("selection-only consumers preserve click and keyboard selection without opening details", async () => {
  await page.goto(`${baseURL}?selectionOnly`)
  const node = page.getByRole("button", { name: "Task: Select task", exact: true })
  await node.click()
  await node.press("Enter")
  await node.press("Space")
  expect(await page.evaluate(() => (window as unknown as { selectedNodes: string[] }).selectedNodes)).toEqual([
    "select",
    "select",
    "select",
  ])
  expect(await page.locator('[data-slot="dag-node-preview"]').count()).toBe(0)
})

test("fixed summary and read-only Todo use current-view counts and complete wrapping", async () => {
  const before = await page.locator(".session-progress-island-header").boundingBox()
  await expand()
  const after = await page.locator(".session-progress-island-header").boundingBox()
  expect(after?.width).toBe(before?.width)
  expect(after?.height).toBe(before?.height)
  expect(await page.locator(".session-progress-island-count").textContent()).toBe("0/2 complete · 1 cancelled")
  expect(await page.locator(".session-progress-todo-row").count()).toBe(3)
  expect(await page.locator(".session-progress-todo-row button, .session-progress-todo-row[role=button]").count()).toBe(
    0,
  )
  await page.getByRole("img", { name: "In progress", exact: true }).waitFor()
  expect(await page.getByRole("img", { name: "In progress", exact: true }).count()).toBe(1)
  expect(
    await page
      .locator(".session-progress-todo-content")
      .first()
      .evaluate((node) => getComputedStyle(node).whiteSpace),
  ).toBe("pre-wrap")
  expect(errors).toEqual([])
})

test("DAG click and native keyboard share details; nested Escape restores node before collapsing progress", async () => {
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  const node = page.getByRole("button", { name: "Task: Prepare the fixture", exact: true })
  await node.click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
  await page.keyboard.press("Escape")
  await page.locator('[data-slot="dag-node-preview"]').waitFor({ state: "detached" })
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("true")
  await page.waitForFunction((element) => element === document.activeElement, await node.elementHandle())
  await node.press("Space")
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
  await change("failed")
  expect(await page.locator('[data-slot="dag-node-preview-status"]').textContent()).toBe("FAILED")
  await page.keyboard.press("Escape")
  await page.locator('[data-slot="dag-node-preview"]').waitFor({ state: "detached" })
  await page.waitForFunction((node) => document.activeElement === node, await node.elementHandle())
  await page.keyboard.press("Escape")
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("false")
  expect(await page.locator('[data-component="dag-graph"]').evaluate((node) => !!node.closest("[inert]"))).toBe(true)
  expect(errors).toEqual([])
})

test("DAG instance and manual viewport survive tab changes and collapse, with no hover details", async () => {
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.locator('[data-component="dag-graph"]').evaluate((node) => {
    ;(window as unknown as { graph: Element }).graph = node
  })
  const node = page.getByRole("button", { name: "Task: Prepare the fixture", exact: true })
  await node.hover()
  await page.clock.install()
  await page.clock.runFor(2500)
  expect(await page.locator('[data-slot="dag-node-preview"]').count()).toBe(0)
  const bounds = (await node.boundingBox())!
  await page.mouse.move(bounds.x + 40, bounds.y + 40)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 100, bounds.y + 80, { steps: 3 })
  await page.mouse.up()
  expect(await page.locator('[data-slot="dag-node-preview"]').count()).toBe(0)
  const transform = await page.locator('[data-slot="dag-graph-stage"]').getAttribute("style")
  await change("failed")
  await page.clock.runFor(300)
  expect(await page.locator('[data-slot="dag-graph-stage"]').getAttribute("style")).toBe(transform)
  await page.getByRole("button", { name: "To-do", exact: true }).click()
  await expand()
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((node) => node === (window as unknown as { graph: Element }).graph),
  ).toBe(true)
  expect(errors).toEqual([])
})

test("unresolved failure survives idle and completion does not interrupt expanded DAG reading", async () => {
  await page.clock.install()
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await change("failed")
  await page.getByRole("button", { name: "Fit", exact: true }).focus()
  await change("idle")
  await page.clock.runFor(2200)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  expect(
    await page.getByRole("button", { name: "Fit", exact: true }).evaluate((node) => node === document.activeElement),
  ).toBe(true)
  await change("complete")
  await page.clock.runFor(2200)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  expect(
    await page.getByRole("button", { name: "Fit", exact: true }).evaluate((node) => node === document.activeElement),
  ).toBe(true)
  await expand()
  await page.clock.runFor(1800)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
  expect(
    await page.getByRole("textbox", { name: "Composer" }).evaluate((node) => node === document.activeElement),
  ).toBe(true)
})

test("unfinished progress describes real parent and child activity without dismissing on idle", async () => {
  await page.clock.install()
  const title = page.locator(".session-progress-island-title")
  await change("idle")
  await change("children-ended")
  await page.clock.runFor(2000)
  expect(await title.textContent()).toContain("Unfinished")
  await change("child-busy")
  expect(await title.textContent()).not.toContain("Unfinished")
  await change("wait")
  expect(await title.textContent()).toContain("Waiting for you")
  await change("answer")
  await change("children-ended")
  await change("paused")
  await page.clock.runFor(2000)
  expect(await title.textContent()).toContain("Paused")
  await change("idle")
  await change("child-paused")
  expect(await title.textContent()).toContain("Paused")
  await change("disconnect")
  await page.clock.runFor(2000)
  expect(await title.textContent()).toContain("Status unknown")
  await change("connect")
  await page.clock.runFor(1800)
  expect(await title.textContent()).toContain("Paused")
})

test("historical completion stays hidden during hydration, navigation and unrelated new execution", async () => {
  for (const query of ["?completed", "?ended&completed"]) {
    await page.goto(baseURL + query)
    await page.getByRole("textbox", { name: "Composer" }).waitFor()
    await page.clock.install()
    for (const action of ["busy", "unknown", "ready", "switch-session", "switch-back", "memo"]) {
      await change(action)
      await page.clock.runFor(2200)
      expect(await page.locator(".session-progress-island").count()).toBe(0)
    }
  }
})

test("task completion dismisses while execution continues and unrelated state cannot resurrect it", async () => {
  await page.clock.install()
  await change("complete")
  await page.clock.runFor(1500)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await change("busy")
  await change("memo")
  await page.clock.runFor(300)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
  for (const action of ["idle", "busy", "persisted-work", "wait", "disconnect", "connect"]) {
    await change(action)
    await page.clock.runFor(2200)
    expect(await page.locator(".session-progress-island").count()).toBe(0)
  }
  await change("new-dag")
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await change("complete")
  await page.clock.runFor(1800)
  await change("reopen-todo")
  expect(await page.locator(".session-progress-island").count()).toBe(1)
})

test("completion and cancellation settle while disconnected and suppression cannot revive their receipt", async () => {
  await page.clock.install()
  for (const action of ["complete", "cancel-all"]) {
    await change("new-dag")
    await change("disconnect")
    await change(action)
    if (action === "cancel-all") {
      expect(await page.locator(".session-progress-island-title").textContent()).toContain("Ended")
      expect(await page.locator(".session-progress-island-title").textContent()).toContain("cancelled")
    }
    await change("offer")
    await page.clock.runFor(1800)
    await change("dismiss-offer")
    await change("connect")
    expect(await page.locator(".session-progress-island").count()).toBe(0)
  }
})

test("selected completed tabs cannot hide unfinished work or label it complete", async () => {
  await page.clock.install()
  await change("todo-complete")
  const title = page.locator(".session-progress-island-title")
  expect(await title.textContent()).toContain("Prepare the fixture")
  await expand()
  await page.getByRole("button", { name: "To-do", exact: true }).click()
  expect(await page.locator(".session-progress-island-count").textContent()).toBe("2/2 complete · 1 cancelled")
  expect(await title.textContent()).not.toContain("Done")
  await change("complete-dag")
  await change("reopen-todo")
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  expect(await page.locator(".session-progress-island-count").textContent()).toBe("2/2 complete")
  expect(await title.textContent()).toContain("Inspect the request interaction")
  await change("idle")
  await page.clock.runFor(2200)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
})

test("removing all task data removes progress even during execution", async () => {
  await expand()
  await change("clear-dag")
  await page.locator(".session-progress-island-header").focus()
  await change("clear-todo")
  expect(await page.locator(".session-progress-island").count()).toBe(0)
  expect(await page.locator("#composer").evaluate((node) => node === document.activeElement)).toBe(true)
  await change("busy")
  expect(await page.locator(".session-progress-island").count()).toBe(0)
})

test("Chinese task states and expanded completion remain readable in narrow light and dark views", async () => {
  await page.setViewportSize({ width: 375, height: 430 })
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.goto(baseURL + "?chinese&compressed&ended")
    await page.locator("#composer").waitFor()
    await page.waitForFunction((scheme) => document.documentElement.dataset.colorScheme === scheme, colorScheme)
    await page.clock.install()
    await change("children-ended")
    const header = page.locator(".session-progress-island-header")
    expect(await header.textContent()).toContain("尚未完成")
    await change("wait")
    expect(await header.getAttribute("aria-label")).toContain("等待你处理")
    await change("answer")
    await change("paused")
    expect(await header.textContent()).toContain("已暂停")
    const bounds = (await header.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(375)
    await expand()
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    await change("complete")
    await page.clock.runFor(2200)
    expect(await dialog.isVisible()).toBe(true)
    await page.keyboard.press("Escape")
    await page.clock.runFor(1800)
    expect(await page.locator(".session-progress-island").count()).toBe(0)
  }
})

test("large DAG retains its instance and closes inspector when switching views", async () => {
  await change("large")
  await expand()
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  await page.locator('[data-slot="dag-graph-node-action"]').first().waitFor({ state: "attached" })
  expect(await page.locator('[data-slot="dag-graph-node-action"]').count()).toBe(400)
  await page.locator('[data-component="dag-graph"]').evaluate((node) => {
    ;(window as unknown as { largeGraph: Element }).largeGraph = node
  })
  await page.locator('[data-slot="dag-graph-node-action"]').first().focus()
  await page.keyboard.press("Enter")
  await page.locator('[data-slot="dag-node-preview"]').waitFor()
  await page.getByRole("button", { name: "To-do", exact: true }).click()
  await page.locator('[data-slot="dag-node-preview"]').waitFor({ state: "detached" })
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  expect(
    await page
      .locator('[data-component="dag-graph"]')
      .evaluate((node) => node === (window as unknown as { largeGraph: Element }).largeGraph),
  ).toBe(true)
  expect(await page.locator('[data-slot="dag-graph-stats"]').count()).toBe(0)
  expect(errors).toEqual([])
})

test("reduced motion hides an ended receipt without a fade", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.clock.install()
  await change("complete")
  await page.clock.runFor(1601)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
})

test("idle attention restores after navigation and reload without leaking another session's tasks", async () => {
  await page.clock.install()
  for (const state of ["blocked", "failed"]) {
    await page.goto(baseURL + "?ended&" + state)
    await page.locator("#composer").waitFor()
    await page.clock.runFor(3000)
    expect(await page.locator(".session-progress-island-title").textContent()).toContain(state)
    await expand()
    await page.getByRole("button", { name: "DAG", exact: true }).click()
    await page.getByRole("button", { name: "Fit", exact: true }).click()
    await page.clock.runFor(400)
    await page.getByRole("button", { name: "Task: Prepare the fixture", exact: true }).click()
    await change("switch-session")
    expect(await page.locator(".session-progress-island").count()).toBe(0)
    expect(await page.locator('[data-slot="dag-node-preview"]').count()).toBe(0)
    await change("switch-back")
    expect(await page.locator(".session-progress-island-title").textContent()).toContain(state)
    expect(await page.locator(".session-progress-island-header").getAttribute("aria-expanded")).toBe("false")
    await page.reload()
    await page.locator("#composer").waitFor()
    expect(await page.locator(".session-progress-island-title").textContent()).toContain(state)
    await change("switch-session")
    await change("complete")
    await change("switch-back")
    expect(await page.locator(".session-progress-island").count()).toBe(0)
  }
})

test("Todo selection and completion cannot hide DAG attention or change the selected view's counts", async () => {
  await change("mixed")
  await change("todo-complete")
  const title = page.locator(".session-progress-island-title")
  expect(await title.textContent()).toContain("1 failed")
  expect(await title.textContent()).toContain("1 blocked")
  expect(await page.locator(".session-progress-island-header").getAttribute("aria-label")).toContain("blocked")
  await expand()
  await page.getByRole("button", { name: "To-do", exact: true }).click()
  expect(await page.locator(".session-progress-island-count").textContent()).toBe("2/2 complete · 1 cancelled")
  await page.getByRole("button", { name: "DAG", exact: true }).click()
  expect(await page.locator(".session-progress-island-count").textContent()).toBe("0/2 complete")
  await page.getByRole("button", { name: "To-do", exact: true }).click()
  expect(await title.textContent()).toContain("1 failed")
  expect(await title.textContent()).toContain("1 blocked")
  await change("resolved")
  expect(await title.textContent()).toContain("1 blocked")
  expect(await title.textContent()).not.toContain("failed")
  await change("clear-dag")
  expect(await title.textContent()).toContain("Done")
})

test("late attention cancels both idle dismissal phases and can return after the receipt disappeared", async () => {
  await page.clock.install()
  for (const elapsed of [1500, 1650, 2200]) {
    await change("pending")
    await change("complete")
    await page.clock.runFor(elapsed)
    await change("blocked")
    await page.clock.runFor(2200)
    expect(await page.locator(".session-progress-island-title").textContent()).toContain("blocked")
    expect(await page.locator(".session-progress-island").getAttribute("data-exiting")).toBe("false")
    await change("pending")
    await page.clock.runFor(2200)
    expect(await page.locator(".session-progress-island").count()).toBe(1)
    await change("complete")
    await page.clock.runFor(1800)
    expect(await page.locator(".session-progress-island").count()).toBe(0)
  }
})

test("resolving one blocker preserves other unfinished work; only the final task releases progress", async () => {
  await page.clock.install()
  for (const action of ["resolved", "cancelled", "clear-dag"]) {
    await page.goto(baseURL + "?ended&blocked")
    await page.locator("#composer").waitFor()
    expect(await page.locator(".session-progress-island-title").textContent()).toContain("blocked")
    await change(action)
    await page.clock.runFor(2200)
    expect(await page.locator(".session-progress-island").count()).toBe(1)
    await change("complete")
    await page.clock.runFor(1800)
    expect(await page.locator(".session-progress-island").count()).toBe(0)
  }
  await page.goto(baseURL + "?ended&failed")
  await page.locator("#composer").waitFor()
  await change("retry")
  await change("pending")
  await page.clock.runFor(2200)
  expect(await page.locator(".session-progress-island").getAttribute("data-status")).toBe("active")
  await change("idle")
  await page.clock.runFor(2200)
  expect(await page.locator(".session-progress-island").count()).toBe(1)
  await change("complete")
  await page.clock.runFor(1800)
  expect(await page.locator(".session-progress-island").count()).toBe(0)
})

test("attention survives disconnect, unknown status and temporary editor or workflow suppression", async () => {
  await page.clock.install()
  await change("blocked")
  await change("idle")
  await change("disconnect")
  await change("unknown")
  await change("switch-session")
  await change("switch-back")
  await page.clock.runFor(3000)
  expect(await page.locator(".session-progress-island-title").textContent()).toContain("blocked")
  for (const [hide, show] of [
    ["expand-editor", "collapse-editor"],
    ["offer", "dismiss-offer"],
  ]) {
    await change(hide)
    expect(await page.locator(".session-progress-island-header").isVisible()).toBe(false)
    await page.clock.runFor(3000)
    await change(show)
    expect(await page.locator(".session-progress-island-header").isVisible()).toBe(true)
  }
  await change("connect")
  await change("idle")
  await page.clock.runFor(3000)
  expect(await page.locator(".session-progress-island-title").textContent()).toContain("blocked")
})

test("retained attention never moves the Composer, flashes or requests data during updates and hot navigation", async () => {
  await change("blocked")
  await change("idle")
  await page.getByRole("textbox", { name: "Composer" }).fill("Keep my draft")
  const baseline = await page.locator("#composer").boundingBox()
  const requests: string[] = []
  page.on("request", (request) => requests.push(request.url()))
  const frames = await page.evaluate(async () => {
    const frames: { top: number; height: number; visible: boolean; count: number }[] = []
    const change = (window as unknown as { changeProgress(action: string): void }).changeProgress
    for (const action of ["failed", "blocked", "switch-peer", "switch-back", "mixed", "blocked"]) {
      change(action)
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame)
        const entry = document.querySelector<HTMLElement>(".session-progress-island")
        const composer = document.querySelector("#composer")!.getBoundingClientRect()
        frames.push({
          top: composer.top,
          height: composer.height,
          visible: !!entry && Number(getComputedStyle(entry).opacity) === 1,
          count: document.querySelectorAll(".session-progress-island").length,
        })
      }
    }
    return frames
  })
  for (const frame of frames) {
    expect(frame.top).toBe(baseline!.y)
    expect(frame.height).toBe(baseline!.height)
    expect(frame.visible).toBe(true)
    expect(frame.count).toBe(1)
  }
  expect(await page.locator("#composer").inputValue()).toBe("Keep my draft")
  expect(requests).toEqual([])
})

test("live changes share activity rows, wrap above progress, retain zero and open the cold root by keyboard", async () => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(baseURL + "?changes&wide&compressed")
  const button = page.locator("[data-turn-change-status]")
  await button.getByText("300 files").waitFor()
  const rects = await page.locator(".prompt-dock-float-layer > *").evaluateAll((elements) =>
    elements.map((el) => ({
      class: el.className,
      y: el.getBoundingClientRect().top,
      height: el.getBoundingClientRect().height,
      width: el.getBoundingClientRect().width,
      display: getComputedStyle(el).display,
      flex: getComputedStyle(el).flex,
    })),
  )
  expect(rects.length).toBe(3)
  expect(Math.max(...rects.map((r) => r.y)) - Math.min(...rects.map((r) => r.y))).toBeLessThan(12)
  await button.focus()
  await page.keyboard.press("Enter")
  expect(await page.evaluate(() => (window as unknown as { reviewRoots: string[] }).reviewRoots)).toEqual(["cold-root"])
  const column = page.locator(".session-prompt-dock-content")
  const progress = page.locator(".session-progress-island-header")
  for (const width of [720, 375]) {
    if (width === 375) await change("child-ended")
    await column.evaluate((el, width) => (el.style.maxWidth = `${width}px`), width)
    const avatars = (await page.locator(".subagent-dock").boundingBox())!
    const changes = (await button.boundingBox())!
    const summary = (await progress.boundingBox())!
    expect(Math.abs(avatars.y - changes.y)).toBeLessThan(2)
    expect(summary.y).toBeGreaterThan(Math.max(avatars.y + avatars.height, changes.y + changes.height))
    expect(summary.width).toBeGreaterThan(changes.x + changes.width - avatars.x)
    expect(summary.x + summary.width).toBeLessThanOrEqual((await column.boundingBox())!.x + width)
  }
  await button.focus()
  await page.keyboard.press("Tab")
  expect(await progress.evaluate((el) => el === document.activeElement)).toBe(true)
  await page.setViewportSize({ width: 375, height: 900 })
  expect(await button.isVisible()).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.evaluate(() =>
    (window as unknown as { changeProgress: (value: string) => void }).changeProgress("expand-editor"),
  )
  expect(await button.isVisible()).toBe(true)
  expect(await page.locator(".session-progress-island").isVisible()).toBe(false)
  await page.evaluate(() =>
    (window as unknown as { updateChanges: (value: unknown) => void }).updateChanges({
      rootID: "cold-root",
      createdAt: 1,
      summary: {
        diffs: [],
        diffState: { status: "live" },
        diffTotals: { files: 0, additions: 0, deletions: 0 },
        diffHasChanges: true,
        diffRevision: "zero",
      },
    }),
  )
  await button.getByText("0 files").waitFor()
  await page.evaluate(() =>
    (window as unknown as { changeProgress: (value: string) => void }).changeProgress("disconnect"),
  )
  await button.getByText("Recorded changes").waitFor()
  expect(await button.getByText("0 files").isVisible()).toBe(true)
  expect(errors).toEqual([])
}, 30_000)

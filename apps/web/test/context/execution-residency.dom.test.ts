import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

let directory: string, server: BrowserFixture, browser: Browser, page: Page
const errors: string[] = []
type Fixture = {
  hide(owner: "session" | "panel" | "document", value: boolean): void
  restore(): void
  hold(value: boolean): void
  resolve(): void
  facts(): { requests: number; pending: number; aborted: boolean[]; leases: number; total: number; loading: boolean }
}
declare global {
  interface Window {
    executionResidency: Fixture
  }
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".execution-residency-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import { createSignal } from "solid-js"
    import { createGlobalEmitter } from "@solid-primitives/event-bus"
    import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
    export const [sessionActive, setSessionActive] = createSignal(true)
    export const [panelActive, setPanelActive] = createSignal(true)
    const event = createGlobalEmitter()
    const requests=[], pending=[]
    let hold=false, leases=0, history
    const client=createSynergyClient({baseUrl:"http://fixture.test",fetch:async request=>{
      requests.push(request)
      if(hold) return new Promise(resolve=>pending.push({request,resolve}))
      return Response.json({sessionID:"session",revision:1,total:1,items:[],nextCursor:null})
    }})
    export const useSDK=()=>({scopeID:"scope",client,event,connected:()=>true})
    export const useGlobalSDK=()=>({capabilities:{has:()=>true},content:{view(){leases++;return()=>leases--}}})
    export const useWorkbenchPanels=()=>({openPanel(){}})
    export const useParams=()=>({id:"session"})
    export const attach=value=>history=value
    window.executionResidency={
      hide(owner,value){
        if(owner==="session")setSessionActive(!value)
        else if(owner==="panel")setPanelActive(!value)
        else { Object.defineProperty(document,"visibilityState",{configurable:true,value:value?"hidden":"visible"});document.dispatchEvent(new Event("visibilitychange")) }
      },
      restore(){event.emit("server.view.patch",{properties:{sessionID:"session",snapshot:{}}})},
      hold(value){hold=value},
      resolve(){for(const entry of pending.splice(0))entry.resolve(Response.json({sessionID:"session",revision:999,total:999,items:[],nextCursor:null}))},
      facts(){return {requests:requests.length,pending:pending.length,aborted:pending.map(entry=>entry.request.signal.aborted),leases,total:history.state.total,loading:history.state.loading}}
    }
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { ExecutionProvider, useExecution } from "@/context/execution"
    import { ViewActivityProvider } from "@/context/view-residency"
    import { sessionActive, panelActive, attach } from "./services"
    function Consumer(){const history=useExecution().createContextHistory({runID:()=>"",selected:()=>"",active:()=>true});attach(history);return <output>{history.state.total}</output>}
    render(()=><ViewActivityProvider active={sessionActive}><ExecutionProvider><ViewActivityProvider active={panelActive}><Consumer/></ViewActivityProvider></ExecutionProvider></ViewActivityProvider>,document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: directory,
    aliases: [
      {
        find: /^(?:@\/context\/|\.\/)(?:sdk|global-sdk|workbench|session-route)$/,
        replacement: path.join(directory, "services.ts"),
      },
      { find: "@", replacement: path.resolve(import.meta.dir, "../../src") },
    ],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})
for (const owner of ["session", "panel", "document"] as const) {
  test(`hidden ${owner} releases the execution lease, aborts reads and defers recovery without losing the snapshot`, async () => {
    errors.length = 0
    await page.goto(server.url)
    await page.waitForFunction(() => window.executionResidency?.facts().total === 1)
    expect((await page.evaluate(() => window.executionResidency.facts())).leases).toBe(1)
    await page.evaluate(() => {
      window.executionResidency.hold(true)
      window.executionResidency.restore()
    })
    await page.waitForFunction(() => window.executionResidency.facts().pending === 1)
    await page.evaluate((owner) => window.executionResidency.hide(owner, true), owner)
    const before = await page.evaluate(() => window.executionResidency.facts())
    expect(before.leases).toBe(0)
    expect(before.aborted).toEqual([true])
    expect(before.loading).toBe(false)
    await page.evaluate(() => {
      window.executionResidency.restore()
      window.executionResidency.resolve()
    })
    const hidden = await page.evaluate(() => window.executionResidency.facts())
    expect(hidden.requests).toBe(before.requests)
    expect(hidden.total).toBe(1)
    await page.evaluate((owner) => {
      window.executionResidency.hold(false)
      window.executionResidency.hide(owner, false)
    }, owner)
    await page.waitForFunction(() => !window.executionResidency.facts().loading)
    const resumed = await page.evaluate(() => window.executionResidency.facts())
    expect(resumed.leases).toBe(1)
    expect(resumed.requests).toBe(before.requests + 1)
    expect(resumed.total).toBe(1)
    expect(errors).toEqual([])
  })
}

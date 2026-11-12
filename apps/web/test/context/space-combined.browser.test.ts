import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"
import { organizationCommandFixtureSource } from "../support/organization-command-fixture"

type RequestRecord = { source: string; path: string; method: string; body?: string; aborted?: boolean }
type Driver = {
  requests: RequestRecord[]
  sockets: Array<{ readyState: number; sent: Array<{ payload?: { type: string; properties?: { active?: unknown } } }> }>
  starts: Array<{ connectionID: string }>
  uploads: Array<{ id: string; filename: string; text: string }>
  held: Array<{ source: string; path: string }>
  navigations: string[]
  hold(source: string, path: string): void
  release(): void
  emit(id: "a" | "b", kind?: "completion" | "error"): Promise<void>
  personal(sessionID: string): void
  replaceA(): void
  retireA(): Promise<void>
}
declare global {
  interface Window {
    combinedSpaceFixture: Driver
  }
}

let browser: Browser
let fixture: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")

beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.space-combined-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><head><script>const fixtureURL=new URL(location.href);fixtureURL.searchParams.set("url",location.origin);history.replaceState(null,"",fixtureURL)</script></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { AppBaseProviders, AppInterface } from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import { PlatformProvider } from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    import { notifyBrowser } from ${JSON.stringify(`/@fs/${source}/context/notification-platform.ts`)}
    ${organizationCommandFixtureSource}
    const entries = ["a", "b"].map(id => ({id:id.repeat(64),revision:"00000000-0000-4000-8000-000000000001",issuer:"https://"+id+".example",clientID:"desktop",orgID:"org-"+id,deploymentIncarnation:"deployment-"+id,account:{accountID:"account-"+id,orgID:"org-"+id,loginName:id,displayName:"Member "+id.toUpperCase(),role:"member",state:"active",revision:1,authRevision:1,createdAt:1},state:"ready"}))
    const listeners = new Set(), active = new Map(), sequences = new Map(), gates = [], released = []
    const api = window.combinedSpaceFixture = {
      requests:[], sockets:[], starts:[], uploads:[], held:[], navigations:[],
      hold(source,path){gates.push({source,path})},
      release(){gates.length=0;for(const resolve of released.splice(0))resolve()},
      replaceA(){entries[0]={...entries[0],revision:"00000000-0000-4000-8000-000000000002",deploymentIncarnation:"deployment-a-next",account:{...entries[0].account,accountID:"account-a-next",displayName:"Member A next"}}},
      personal(sessionID){const socket=this.sockets.findLast(value=>value.readyState===1);socket.onmessage?.({data:JSON.stringify({scopeID:"home",payload:{type:"session.completion",properties:{sessionID,unreadCount:1}}})})},
      async retireA(){const request=active.get(entries[0].id);if(request)await Promise.all([...listeners].map(listener=>listener({...request,type:"closed",code:"connection_changed"})))},
      async emit(id,kind="completion"){
        const entry=entries.find(value=>value.id[0]===id),request=active.get(entry.id)
        if(!request)throw new Error("The original notification subscription has not opened")
        const sequence=(sequences.get(request.requestID)||0)+1;sequences.set(request.requestID,sequence)
        await Promise.all([...listeners].map(listener=>listener({requestID:request.requestID,connectionID:request.connectionID,revision:request.revision,type:"frame",frame:{type:"notice",streamID:request.streamID,sequence,notice:{noticeID:crypto.randomUUID(),kind,sessionID:"session-"+id,binding:{schemaVersion:1,orgID:entry.orgID,projectID:"project-"+id,creatorID:entry.account.accountID,driverRuntimeID:"runtime-"+id,bindingEpoch:1},occurredAt:1}}})))
      }
    }
    async function barrier(source,path){if(gates.some(value=>value.source===source&&path.startsWith(value.path))){api.held.push({source,path});await new Promise(resolve=>released.push(resolve))}}
    const nativePush=history.pushState.bind(history)
    history.pushState=(state,title,path)=>{api.navigations.push(String(path));nativePush(state,title,path)}
    class Socket {
      static OPEN=1;static CLOSED=3;readyState=1;sent=[]
      constructor(url){this.url=url;api.sockets.push(this);queueMicrotask(()=>this.onopen?.())}
      send(raw){const value=JSON.parse(raw);this.sent.push(value);if(value.payload?.type==="client.ping")queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({payload:{type:"server.pong",properties:{}}})}))}
      close(){this.readyState=3;this.onclose?.()}
    }
    Object.defineProperty(window,"WebSocket",{configurable:true,value:Socket})
    class Notice {static permission="granted";constructor(){}close(){}}
    Object.defineProperty(window,"Notification",{configurable:true,value:Notice})
    const binding = id => ({schemaVersion:1,orgID:"org-"+id,projectID:"project-"+id,creatorID:"account-"+id,driverRuntimeID:"runtime-"+id,bindingEpoch:1})
    const project = id => ({projectID:"project-"+id,orgID:"org-"+id,name:"Project "+id.toUpperCase(),description:"Synthetic "+id,state:"active",revision:1,createdAt:1,role:"maintainer",permissions:{read:true,execute:true,manage:true}})
    const session = id => ({sessionID:"session-"+id,projectID:"project-"+id,creatorID:binding(id).creatorID,driverRuntimeID:"runtime-"+id,bindingEpoch:1,createdAt:1,shareState:"private",resourceIDs:[],permissions:{read:true,execute:true,stop:true},runtime:{runtimeID:"runtime-"+id,runtimeKind:"member",ownerID:binding(id).creatorID,state:"online",connectionEpoch:1}})
    const success = (body,status=200) => ({ok:true,value:{status,body:JSON.stringify(body)}})
    window.hostRequest=async input=>{
      const id=input.connectionID[0], url=new URL(input.path,"https://fixture.invalid"), body=input.body?JSON.parse(input.body):undefined
      api.requests.push({source:id,path:url.pathname,method:input.method,body:input.body})
      await barrier(id,url.pathname)
      if(entries.find(value=>value.id===input.connectionID).account.accountID!=="account-"+id){
        if(url.pathname.startsWith("/org/v1/sessions/"))return success({code:"PERMISSION_DENIED",message:"The replacement account cannot read the original private session",outcome:"not_dispatched",retryable:false},403)
        if(url.pathname==="/org/v1/projects/project-"+id+"/sessions")return success({items:[]})
      }
      if(url.pathname.endsWith("/commands/input")||url.pathname.endsWith("/control")||url.pathname.endsWith("/interactions/reply")){
        sessionStorage.setItem("combined-server-command",JSON.stringify(body))
        return success({code:"COMMAND_OUTCOME_UNKNOWN",message:"The fixture holds the original receipt",outcome:"unknown",retryable:false},504)
      }
      if(url.pathname.startsWith("/org/v1/commands/"))return success({requestID:url.pathname.split("/").at(-1),attemptID:"original-attempt",state:"not_dispatched",authorizedAt:1})
      if(url.pathname==="/org/v1/organization")return success({orgID:"org-"+id,name:"Team "+id.toUpperCase(),revision:1})
      if(url.pathname==="/org/v1/projects")return success({items:[project(id)]})
      if(url.pathname==="/org/v1/projects/project-"+id)return success(project(id))
      if(url.pathname==="/org/v1/projects/project-"+id+"/sessions")return success({items:[session(id)]})
      if(url.pathname==="/org/v1/sessions/session-"+id)return success(session(id))
      if(url.pathname.endsWith("/share"))return success({sessionID:"session-"+id,shareState:"private",shareGeneration:0,bindingEpoch:1,nextSeq:1,syncState:"pending",updatedAt:1})
      if(url.pathname.endsWith("/resources"))return success({sessionID:"session-"+id,revision:1,selection:{modelResourceID:"model-"+id,connectionResourceIDs:[],infrastructure:{workspace:null,environment:null}}})
      if(url.pathname.endsWith("/interactions"))return success({rootSessionID:"session-"+id,sourceSessionID:"session-"+id,binding:binding(id),runtimeKind:"member",operation:body.operation,...(body.operation==="pending"?{items:id==="a"?[{kind:"permission",requestID:"permission-a",sourceSessionID:"session-a",permission:"bash",patterns:["synthetic A operation"],alwaysScope:"runtime"}]:[],hasMore:false}:{items:body.identities.map(identity=>({identity,state:"pending"}))})})
      if(url.pathname.endsWith("/read"))return success({rootSessionID:"session-"+id,sourceSessionID:"session-"+id,binding:binding(id),operation:body.operation,...(body.operation==="session"?{session:{sessionID:"session-"+id,title:"Private "+id.toUpperCase(),createdAt:1,updatedAt:1}}:body.operation==="timeline"?{items:[],referencedRoots:[],hasMore:false,total:0,generation:1}:body.operation==="tasks"?{items:[],hasMore:false}:{status:{type:"busy",runID:"run-"+id,controlVersion:7,observedAt:1}})})
      if(url.pathname.endsWith("/knowledge/status"))return success({desired:{revision:0,manifestHash:"0".repeat(64),count:0},state:"pending"})
      if(url.pathname.includes("/artifacts")||url.pathname.includes("/knowledge")||url.pathname.includes("/members"))return success({items:[]})
      return success({code:"FIXTURE_ROUTE_MISSING",message:input.method+" "+url.pathname},501)
    }
    const bridge={protocolVersion:2,notificationVersion:1,list:async()=>({ok:true,value:entries}),connect:async()=>({ok:true,value:entries[0]}),request:window.hostRequest,commandStream,
      cancel:async value=>{commandTransfers.delete(value.requestID);return{ok:true}},
      memberStatus:async input=>({ok:true,value:{connectionID:input.connectionID,state:"stopped"}}),
      onNotification(listener){listeners.add(listener);return()=>listeners.delete(listener)},
      async notificationStart(input){const entry=entries.find(value=>value.id===input.connectionID),request={...input,streamID:crypto.randomUUID()};api.starts.push(input);active.set(input.connectionID,request);await Promise.all([...listeners].map(listener=>listener({...input,type:"frame",frame:{type:"ready",sequence:0,streamID:request.streamID,orgID:entry.orgID,accountID:entry.account.accountID,deploymentIncarnation:entry.deploymentIncarnation,authRevision:entry.account.authRevision}})));return{ok:true}},
      notificationStop:async()=>({ok:true})}
    const model={id:"model",name:"Synthetic model",providerID:"fixture",api:{id:"model",url:"https://fixture.invalid",npm:"@ai-sdk/openai-compatible"},release_date:"2026-01-01",capabilities:{attachment:true,reasoning:false,temperature:true,toolcall:true,input:{text:true,image:true,audio:false,video:false,pdf:false},output:{text:true,image:false,audio:false,video:false,pdf:false},interleaved:false},limit:{context:32768,output:4096},cost:{input:0,output:0},options:{},headers:{},status:"active"}
    const provider={all:[{id:"fixture",name:"Synthetic provider",models:{model}}],connected:["fixture"],default:{fixture:"model"},profiles:{},complete:true,runtimeAvailability:{fixture:{available:true}}}
    const config={model:"fixture/model",default_agent:"general",controlProfile:"guarded",attachment:{}}
    const paths={home:"/synthetic/personal",root:"/synthetic/personal",data:"/synthetic/personal/data",config:"/synthetic/personal/config",state:"/synthetic/personal/state",cache:"/synthetic/personal/cache",log:"/synthetic/personal/log"}
    const scope={id:"home",type:"home",local:null,time:{created:1,updated:1}}
    const personalPath={...paths,worktree:null,directory:null,workspace:null}
    const agent=[{name:"general",description:"Synthetic primary agent",mode:"primary",native:true,options:{},permission:[]}]
    async function personalFetch(original,init){
      const request=new Request(original,init),url=new URL(request.url),pathname=url.pathname
      const record={source:"personal",path:pathname,method:request.method,aborted:request.signal.aborted};api.requests.push(record)
      request.signal.addEventListener("abort",()=>{record.aborted=true},{once:true})
      await barrier("personal",pathname)
      if(pathname.endsWith("/global/health"))return Response.json({healthy:true})
      if(pathname.endsWith("/global/capabilities"))return Response.json({apiVersion:1,runtimeID:"00000000-0000-4000-8000-000000000001",features:["workbench"],transports:{projection:"projection"}})
      if(pathname.endsWith("/global/paths"))return Response.json(paths)
      if(pathname.endsWith("/config/global")||pathname.endsWith("/config"))return Response.json(config)
      if(pathname.endsWith("/scope/bootstrap-core"))return Response.json({scopeID:"home",provider,agent,config,path:personalPath,workspaces:[],command:[],sessionStatus:{},sessions:{data:[],total:0},cortex:[],agenda:[],mcp:{},lsp:[]})
      if(pathname.endsWith("/scope"))return Response.json([scope])
      if(pathname.endsWith("/scope/index"))return Response.json([])
      if(pathname.endsWith("/global/recent"))return Response.json({items:[],nextCursor:null,total:0,unreadCompletionCount:0})
      if(pathname.endsWith("/session/index"))return Response.json({items:[],nextCursor:null,total:0})
      if(pathname.endsWith("/cortex/tasks"))return Response.json([])
      if(pathname.endsWith("/path"))return Response.json(personalPath)
      if(pathname.endsWith("/provider"))return Response.json(provider)
      if(pathname.endsWith("/provider/auth"))return Response.json({})
      if(pathname.endsWith("/provider/models-by-id"))return Response.json({items:[],complete:true})
      if(pathname.endsWith("/agent"))return Response.json(agent)
      if(pathname.endsWith("/project/directories"))return Response.json({version:1,scopeID:"home",revision:1,mainWorkspaceID:null,additionalWorkspaceIDs:[],folders:[]})
      if(pathname.endsWith("/global/session"))return Response.json({data:[{id:"personal-search",title:"Personal search result",scope:{id:"home",type:"home",local:null},time:{created:1,updated:2}}],total:1})
      if(pathname.endsWith("/asset")&&request.method==="POST"){
        const form=await request.formData(),file=form.get("file"),text=await file.text(),id=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,"0")).join("")
        api.uploads.push({id,filename:file.name,text});return Response.json({id,url:"asset://"+id,mime:file.type,size:file.size})
      }
      if(pathname.includes("/asset/")){const upload=api.uploads.find(value=>value.id===pathname.split("/").at(-1));return new Response(upload?.text??"Synthetic attachment",{headers:{"content-type":"text/plain"}})}
      if(pathname.endsWith("/global/session/status")||pathname.endsWith("/session/status"))return Response.json({})
      if(pathname.endsWith("/session"))return Response.json({data:[],total:0})
      if(pathname.includes("/session/")&&pathname.endsWith("/timeline"))return Response.json({items:[],referencedRoots:[],hasMore:false,total:0})
      if(pathname.includes("/session/")&&!pathname.endsWith("/inbox"))return Response.json({id:pathname.split("/").at(-1),title:"Personal task",scope,workspace:null,workspaceID:null,environmentID:null,time:{created:1,updated:1}})
      if(["/host/connections","/permission","/question","/workspace","/command","/cortex","/lsp","/mcp","/config/domains","/config/diagnostics","/global/agenda","/global/cortex","/session/personal/inbox"].some(value=>pathname.endsWith(value)))return Response.json([])
      return Response.json({})
    }
    const rawFetch=window.fetch.bind(window)
    window.fetch=(input,init)=>new URL(input instanceof Request?input.url:String(input),location.href).pathname.includes("/asset/")?personalFetch(input,init):rawFetch(input,init)
    const platform={platform:"web",openLink(){},fetch:personalFetch,notify:notifyBrowser,organization:bridge}
    render(()=><PlatformProvider value={platform}><AppBaseProviders><AppInterface/></AppBaseProviders></PlatformProvider>,document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    styled: true,
    localized: true,
    aliases: [{ find: "@", replacement: source }],
  })
  browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

const personalEditor = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]')
async function switchSpace(page: Page, id: "personal" | "a" | "b") {
  const collapse = page.getByRole("button", { name: "Collapse workspace", exact: true })
  if (await collapse.isVisible()) await collapse.click()
  const panel = page.getByRole("button", { name: "Hide side workspace", exact: true })
  if (await panel.isVisible()) await panel.click()
  const navigation = page.getByRole("button", { name: "Open navigation", exact: true })
  if (await navigation.isVisible()) await navigation.click()
  await page.getByRole("button", { name: "Current space", exact: true }).click()
  await page
    .getByRole("menuitem", {
      name: id === "personal" ? "Personal space" : new RegExp(`${id}.example.*Member ${id.toUpperCase()}`),
      exact: id === "personal",
    })
    .click()
  await page.getByRole("dialog", { name: "Navigation", exact: true }).waitFor({ state: "hidden" })
}
async function openOrganization(page: Page, id: "a" | "b") {
  await switchSpace(page, id)
  await page.getByRole("button", { name: new RegExp(`Project ${id.toUpperCase()}`) }).click()
  await page.getByRole("button", { name: "Conversations", exact: true }).click()
  await page.getByRole("button", { name: /Private conversation/ }).click()
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
}
async function screenshot(page: Page, name: string) {
  if (!process.env.SYNERGY_UI_SCREENSHOT_DIR) return
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    )
  })
  await fs.mkdir(process.env.SYNERGY_UI_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, `${name}.png`) })
}
async function failure(page: Page, name: string, errors: string[]) {
  if (!process.env.SYNERGY_UI_SCREENSHOT_DIR) return
  await screenshot(page, name).catch(() => {})
  const observed = await page.evaluate(() => ({
    url: location.href,
    alerts: [...document.querySelectorAll('[role="alert"]')].map((value) => value.textContent?.slice(0, 300)),
    requests: window.combinedSpaceFixture?.requests
      .slice(-24)
      .map(({ source, path, method }) => ({ source, path, method })),
  }))
  await fs.writeFile(
    path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, `${name}.json`),
    JSON.stringify({ errors, ...observed }),
  )
}

for (const variant of [
  { width: 375, height: 740, colorScheme: "light" as const },
  { width: 1100, height: 760, colorScheme: "dark" as const },
]) {
  test(`the full online App restores personal attachments and isolates A/B drafts and search at ${variant.width}px${variant.width >= 768 ? " with desktop resource tabs" : ""}`, async () => {
    const page = await browser.newPage({ viewport: variant, colorScheme: variant.colorScheme })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.goto(new URL("/aG9tZQ/session", fixture.url).href)
      await personalEditor(page).waitFor()
      await personalEditor(page).fill("Personal unsent text")
      const chooser = page.waitForEvent("filechooser")
      await page.getByRole("button", { name: "Add", exact: true }).click()
      await page.getByText("Add files", { exact: true }).click()
      await (
        await chooser
      ).setFiles({
        name: "personal-draft.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic personal attachment bytes"),
      })
      await page.locator('.prompt-attachments [data-component="attachment-card"]').waitFor()
      await page.locator('.prompt-attachments button[data-component="attachment-card"]').click()
      await page.getByRole("dialog", { name: "Attachment preview", exact: true }).waitFor()
      await page.keyboard.press("Escape")
      if (variant.width >= 768) {
        await page.getByRole("button", { name: "Open side workspace", exact: true }).click()
        await page.getByRole("tab", { name: "New tab", exact: true }).waitFor()
        await page.getByRole("button", { name: "Collapse workspace", exact: true }).click()
      }
      const navigation = page.getByRole("button", { name: "Open navigation", exact: true })
      if (await navigation.isVisible()) await navigation.click()
      await page.getByRole("button", { name: "Search sessions", exact: true }).click()
      await page.getByRole("combobox", { name: "Search sessions", exact: true }).fill("Personal search")
      await page.getByRole("option", { name: /Personal search result/ }).waitFor()
      await page.keyboard.press("Escape")
      await openOrganization(page, "a")
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("A unsent text")
      await openOrganization(page, "b")
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("B unsent text")
      expect(await page.getByText("Personal search result", { exact: true }).count()).toBe(0)
      expect(await page.getByRole("tab", { name: "New tab", exact: true }).count()).toBe(0)
      await screenshot(page, `combined-B-${variant.width}`)
      await openOrganization(page, "a")
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
      expect(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()).toBe("A unsent text")
      await switchSpace(page, "personal")
      await personalEditor(page).waitFor()
      await personalEditor(page).click()
      expect(await personalEditor(page).evaluate((element) => element === document.activeElement)).toBe(true)
      expect(await personalEditor(page).innerText()).toBe("Personal unsent text")
      await page.locator('.prompt-attachments [data-component="attachment-card"]').waitFor()
      if (variant.width >= 768) {
        await page.getByRole("button", { name: "Open side workspace", exact: true }).click()
        await page.getByRole("tab", { name: "New tab", exact: true }).waitFor()
      }
      expect(await page.evaluate(() => window.combinedSpaceFixture.uploads.map((value) => value.filename))).toEqual([
        "personal-draft.txt",
      ])
      expect(await page.evaluate(() => window.combinedSpaceFixture.sockets.length)).toBe(1)
      expect(await page.evaluate(() => window.combinedSpaceFixture.starts.length)).toBe(2)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await screenshot(page, `combined-personal-restored-${variant.width}`)
      expect(errors).toEqual([])
    } catch (error) {
      await failure(page, `combined-roundtrip-failed-${variant.width}`, errors)
      throw error
    } finally {
      await page.evaluate(() => window.combinedSpaceFixture?.release()).catch(() => {})
      await page.close()
    }
  }, 45_000)

  test(`the full App receives A behind B and retains each original decision and draft target at ${variant.width}px`, async () => {
    const page = await browser.newPage({ viewport: variant, colorScheme: variant.colorScheme })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.goto(new URL("/aG9tZQ/session", fixture.url).href)
      await personalEditor(page).waitFor()
      await personalEditor(page).fill("Personal notification draft")
      await openOrganization(page, "a")
      await page.getByRole("button", { name: /^(Expand|Collapse) request$/ }).waitFor()
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("A original draft")
      await openOrganization(page, "b")
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("B background draft")
      const appearance = await page.evaluate(() => [
        document.documentElement.lang,
        document.documentElement.dataset.colorScheme,
      ])
      await page.evaluate(() => window.combinedSpaceFixture.emit("a"))
      const open = page.getByRole("button", { name: "Open session", exact: true })
      await open.waitFor()
      await page.locator('[data-component="toast"]').filter({ has: open }).hover()
      await open.click()
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
      expect(page.url()).toContain("/organization/org-a/account-a/deployment-a/projects/project-a/sessions/session-a")
      expect(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()).toBe("A original draft")
      const expand = page.getByRole("button", { name: "Expand request", exact: true })
      if (await expand.isVisible()) await expand.click()
      await page.getByRole("button", { name: "Allow once", exact: true }).waitFor()
      expect(
        await page.evaluate(() =>
          window.combinedSpaceFixture.requests
            .filter((value) => value.path.endsWith("/interactions"))
            .every((value) => JSON.parse(value.body!).rootSessionID === "session-" + value.source),
        ),
      ).toBe(true)
      await openOrganization(page, "b")
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
      expect(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()).toBe("B background draft")
      await page.waitForFunction(() =>
        window.combinedSpaceFixture.sockets[0].sent.some(
          (value) => value.payload?.type === "client.content.interests" && !value.payload.properties?.active,
        ),
      )
      await page.evaluate(() => window.combinedSpaceFixture.personal("personal-background"))
      await page
        .locator('[data-component="toast"]')
        .filter({ hasText: "Personal space" })
        .getByRole("button", { name: "Open session", exact: true })
        .waitFor()
      expect(
        await page.evaluate(() => [document.documentElement.lang, document.documentElement.dataset.colorScheme]),
      ).toEqual(appearance)
      expect(await page.evaluate(() => window.combinedSpaceFixture.sockets.length)).toBe(1)
      expect(errors).toEqual([])
    } catch (error) {
      await failure(page, `combined-notification-failed-${variant.width}`, errors)
      throw error
    } finally {
      await page.close()
    }
  }, 45_000)
}

test("an empty organization input keeps Send disabled without a false size error, while oversized text stays guarded", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  try {
    await page.goto(
      new URL("/organization/org-a/account-a/deployment-a/projects/project-a/sessions/session-a", fixture.url).href,
    )
    const input = page.getByRole("textbox", { name: "Message", exact: true })
    const warning = page.getByRole("alert").filter({ hasText: "This message exceeds the supported input size." })
    await input.waitFor()
    expect(await input.inputValue()).toBe("")
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true)
    expect(await warning.count()).toBe(0)
    await input.fill("x".repeat(1_048_577))
    await warning.waitFor()
    expect(await input.inputValue()).toHaveLength(1_048_577)
    expect(await page.getByRole("button", { name: "Send", exact: true }).isDisabled()).toBe(true)
  } finally {
    await page.close()
  }
}, 30_000)

test("a full App reload reconciles only the original A input while late retired replies cannot replace B's next draft", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  try {
    await page.goto(new URL("/aG9tZQ/session", fixture.url).href)
    await personalEditor(page).waitFor()
    await openOrganization(page, "a")
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Original A input")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await page.getByRole("button", { name: "Check request status", exact: true }).waitFor()
    const original = await page.evaluate(() =>
      window.combinedSpaceFixture.requests.find((value) => value.path.endsWith("/commands/input")),
    )
    expect(original).toBeDefined()
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("A next draft")
    await page.evaluate(() => window.combinedSpaceFixture.hold("a", "/org/v1/commands/"))
    await page.getByRole("button", { name: "Check request status", exact: true }).click()
    await page.waitForFunction(() => window.combinedSpaceFixture.held.length > 0)
    await openOrganization(page, "b")
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("B next draft")
    await page.evaluate(() => window.combinedSpaceFixture.release())
    expect(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()).toBe("B next draft")
    await page.reload()
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor()
    expect(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()).toBe("B next draft")
    expect(
      await page.evaluate(() =>
        window.combinedSpaceFixture.requests.some((value) => value.path.includes("/commands/")),
      ),
    ).toBe(false)
    await openOrganization(page, "a")
    await page.getByRole("button", { name: "Check request status", exact: true }).waitFor()
    expect(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue()).toBe("A next draft")
    await page.getByRole("button", { name: "Check request status", exact: true }).click()
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor()
    const requestID = JSON.parse(original!.body!).requestID
    expect(
      await page.evaluate(
        (requestID) =>
          window.combinedSpaceFixture.requests.some(
            (value) => value.source === "a" && value.path === "/org/v1/commands/" + requestID,
          ),
        requestID,
      ),
    ).toBe(true)
    expect(
      await page.evaluate(
        () => window.combinedSpaceFixture.requests.filter((value) => value.path.endsWith("/commands/input")).length,
      ),
    ).toBe(0)
  } finally {
    await page.evaluate(() => window.combinedSpaceFixture?.release()).catch(() => {})
    await page.close()
  }
}, 45_000)

test("a same-issuer account and deployment replacement retires the original App notification and confirmation", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  try {
    await page.goto(new URL("/aG9tZQ/session", fixture.url).href)
    await personalEditor(page).waitFor()
    await page.waitForFunction(() => window.combinedSpaceFixture.starts.length === 2)
    await page.evaluate(() => window.combinedSpaceFixture.emit("a"))
    await page.getByRole("button", { name: "Open session", exact: true }).waitFor()
    await openOrganization(page, "a")
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Old A only")
    await page.getByRole("button", { name: "Cancel work", exact: true }).click()
    await page.getByRole("dialog").waitFor()
    await page.evaluate(() => window.combinedSpaceFixture.replaceA())
    await page.evaluate(() => {
      history.pushState(null, "", "/organization/connect")
      dispatchEvent(new PopStateEvent("popstate"))
    })
    await page.getByLabel("Organization address").fill("https://a.example")
    await page.getByRole("button", { name: "Connect organization", exact: true }).click()
    await page.getByRole("button", { name: /Project A/ }).waitFor()
    expect(page.url()).toContain("/organization/org-a/account-a-next/deployment-a-next")
    const before = page.url()
    const open = page.getByRole("button", { name: "Open session", exact: true })
    if (await open.count()) {
      await page.locator('[data-component="toast"]').filter({ has: open }).hover()
      await open.click()
    }
    expect(page.url()).toBe(before)
    expect(await page.getByRole("dialog").count()).toBe(0)
    expect(await page.getByText("Old A only", { exact: true }).count()).toBe(0)
    expect(await page.getByRole("textbox", { name: "Message", exact: true }).count()).toBe(0)
    expect(
      await page.evaluate(
        () => window.combinedSpaceFixture.requests.filter((value) => value.path.endsWith("/control")).length,
      ),
    ).toBe(0)
  } finally {
    await page.close()
  }
}, 45_000)

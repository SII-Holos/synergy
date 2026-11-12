import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../support/browser-fixture"

let browser: Browser
let fixture: BrowserFixture
let directory: string
const source = path.resolve(import.meta.dir, "../../src")

declare global {
  interface Window {
    notificationFixture: {
      starts: Array<{ connectionID: string }>
      requests: Array<{ connectionID: string; path: string }>
      navigations: string[]
      notifications: Array<{ title: string; body: string; closed: boolean; onclick?: () => void }>
      sockets: Array<{
        readyState: number
        sent: Array<{ payload: { type: string; properties?: { active?: unknown } } }>
      }>
      headers: Array<{ sessionID: string; signal: AbortSignal }>
      emit(id: "a" | "b", kind?: "completion" | "error"): Promise<void>
      retire(id: "a" | "b"): Promise<void>
      personal(sessionID: string, error?: boolean): void
      switchPersonal(): void
      replacePersonal(): void
      holdHeaders(value: boolean): void
      releaseHeaders(): void
    }
  }
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.resolve(source, "../node_modules/.organization-notifications-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { Show } from "solid-js"
    import { AppBaseProviders, AppInterface } from ${JSON.stringify(`/@fs/${source}/app.tsx`)}
    import { PlatformProvider } from ${JSON.stringify(`/@fs/${source}/context/platform.tsx`)}
    import { ServerProvider, useServer } from ${JSON.stringify(`/@fs/${source}/context/server.tsx`)}
    import { SpaceProvider, useSpace } from ${JSON.stringify(`/@fs/${source}/context/space.tsx`)}
    import { GlobalSDKProvider, useGlobalSDK } from ${JSON.stringify(`/@fs/${source}/context/global-sdk.tsx`)}
    import { NotificationProvider } from ${JSON.stringify(`/@fs/${source}/context/notification.tsx`)}
    import { notifyBrowser } from ${JSON.stringify(`/@fs/${source}/context/notification-platform.ts`)}
    import { Toast } from "@ericsanchezok/synergy-ui/toast"
    const mode = new URLSearchParams(location.search).get("mode")
    let runtimeID = "00000000-0000-4000-8000-000000000001"
    let held = false
    const releases = [], listeners = new Set(), active = new Map(), sequences = new Map()
    const entries = ["a", "b"].map(id => ({ id:id.repeat(64),revision:"00000000-0000-4000-8000-000000000001",issuer:"https://"+id+".example",clientID:"desktop",orgID:"org-"+id,deploymentIncarnation:"deployment-"+id,account:{accountID:"account-"+id,orgID:"org-"+id,loginName:id,displayName:"Member "+id.toUpperCase(),role:"member",state:"active",revision:1,authRevision:1,createdAt:0},state:"ready" }))
    const api = window.notificationFixture = { starts:[],requests:[],navigations:[],notifications:[],sockets:[],headers:[],
      async emit(id,kind="completion") {
        const entry=entries.find(item=>item.id[0]===id), request=active.get(entry.id)
        if(!request)throw new Error("Notification source missing")
        const sequence=(sequences.get(request.requestID)||0)+1;sequences.set(request.requestID,sequence)
        await Promise.all([...listeners].map(listener=>listener({requestID:request.requestID,connectionID:request.connectionID,revision:request.revision,type:"frame",frame:{type:"notice",streamID:request.streamID,sequence,notice:{noticeID:crypto.randomUUID(),kind,sessionID:"session-"+id,binding:{schemaVersion:1,orgID:entry.orgID,projectID:"project-"+id,creatorID:entry.account.accountID,driverRuntimeID:"runtime-"+id,bindingEpoch:1},occurredAt:1}}})))
      },
      async retire(id) { const request=active.get(entries.find(item=>item.id[0]===id).id);await Promise.all([...listeners].map(listener=>listener({requestID:request.requestID,connectionID:request.connectionID,revision:request.revision,type:"closed",code:"connection_changed"}))) },
      personal(sessionID,error=false) { const socket=this.sockets.findLast(item=>item.readyState===1);socket.onmessage?.({data:JSON.stringify({scopeID:"home",payload:error?{type:"session.error",properties:{sessionID,error:"Native personal failure"}}:{type:"session.completion",properties:{sessionID,unreadCount:1}}})}) },
      holdHeaders(value){held=value}, releaseHeaders(){held=false;for(const release of releases.splice(0))release()},
      replacePersonal(){runtimeID="00000000-0000-4000-8000-000000000002";this.refresh?.()},
    }
    const originalPush=history.pushState.bind(history);history.pushState=(value,title,path)=>{api.navigations.push(String(path));originalPush(value,title,path)}
    class Notice { static permission="granted";constructor(title,options){this.title=title;this.body=options.body;this.closed=false;api.notifications.push(this)}close(){this.closed=true} }
    Object.defineProperty(window,"Notification",{configurable:true,value:Notice})
    class Socket { static OPEN=1;readyState=1;sent=[];constructor(url){this.url=url;api.sockets.push(this);queueMicrotask(()=>this.onopen?.())}send(value){this.sent.push(JSON.parse(value))}close(){this.readyState=3;this.onclose?.()} }
    Object.defineProperty(window,"WebSocket",{configurable:true,value:Socket})
    const bridge={protocolVersion:2,notificationVersion:1,list:async()=>({ok:true,value:entries}),
      onNotification(listener){listeners.add(listener);return()=>listeners.delete(listener)},
      async notificationStart(input){api.starts.push(input);const entry=entries.find(value=>value.id===input.connectionID);const request={...input,streamID:crypto.randomUUID()};active.set(input.connectionID,request);await Promise.all([...listeners].map(listener=>listener({...input,type:"frame",frame:{type:"ready",sequence:0,streamID:request.streamID,orgID:entry.orgID,accountID:entry.account.accountID,deploymentIncarnation:entry.deploymentIncarnation,authRevision:entry.account.authRevision}})));return{ok:true}},
      notificationStop:async()=>({ok:true}),cancel:async()=>({ok:true}),
      async request(input){api.requests.push(input);const id=input.connectionID[0],url=new URL(input.path,"https://fixture.invalid");const project={projectID:"project-"+id,orgID:"org-"+id,name:"Project "+id.toUpperCase(),description:"",state:"active",revision:1,createdAt:0,permissions:{read:true,manage:false,execute:false},role:"reader"};
        const denied=url.pathname.startsWith("/org/v1/sessions/")
        const body=denied?{code:"PERMISSION_DENIED",message:"Access removed",outcome:"not_dispatched",retryable:false}:url.pathname==="/org/v1/organization"?{orgID:"org-"+id,name:"Team "+id.toUpperCase(),revision:1}:url.pathname==="/org/v1/projects/project-"+id?project:url.pathname==="/org/v1/projects"?{items:[project]}:{items:[]}
        return{ok:true,value:{status:denied?403:200,body:JSON.stringify(body)}}
      }
    }
    const platform={platform:"web",openLink(){},notify:notifyBrowser,organization:bridge,
      async fetch(input){const request=new Request(input),url=new URL(request.url);if(mode!=="personal")return Response.json({healthy:false});
        if(url.pathname.endsWith("/global/health"))return Response.json({healthy:true});
        if(url.pathname.endsWith("/global/capabilities"))return Response.json({apiVersion:1,runtimeID,features:[],transports:{projection:"projection"}});
        if(url.pathname.includes("/session/")){const sessionID=url.pathname.split("/").at(-1);api.headers.push({sessionID,signal:request.signal});if(held)await new Promise(resolve=>releases.push(resolve));return Response.json({id:sessionID,title:"Personal "+sessionID,parentID:sessionID==="child"?"parent":undefined,scope:{id:"home",type:"home",local:null}})}
        return Response.json([])
      }
    }
    function Personal(){const sdk=useGlobalSDK();sdk.content.active("home","personal");return <p data-testid="personal-source">{sdk.requestKey}</p>}
    function Thin(){const server=useServer();return <SpaceProvider personalRuntimeID={server.runtimeID}><GlobalSDKProvider retained><NotificationProvider><Reading/><Toast.Region limit={5}/></NotificationProvider></GlobalSDKProvider></SpaceProvider>}
    function Reading(){const server=useServer(),space=useSpace();api.refresh=()=>server.refresh();api.switchPersonal=()=>space.personal();return <><button onClick={()=>space.open(JSON.stringify(["organization","org-b","account-b","deployment-b"]))}>Switch B</button><Show when={space.selected()===undefined && server.runtimeID} fallback={<p data-testid="organization-reading">Organization B</p>}><GlobalSDKProvider><Personal/></GlobalSDKProvider></Show></>}
    render(()=><PlatformProvider value={platform}><AppBaseProviders>{mode==="personal"?<ServerProvider defaultUrl={location.origin+"/personal"}><Thin/></ServerProvider>:<AppInterface/>}</AppBaseProviders></PlatformProvider>,document.getElementById("root"))
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

test("the actual App receives A while B is selected and notification clicks enter only the original authorized route", async () => {
  for (const variant of [
    { width: 375, height: 740, colorScheme: "light" as const },
    { width: 1100, height: 760, colorScheme: "dark" as const },
  ]) {
    const page = await browser.newPage({ viewport: variant, colorScheme: variant.colorScheme })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.goto(fixture.url)
      await page.waitForFunction(() => window.notificationFixture.starts.length === 2)
      await page.getByRole("button", { name: "Current space" }).click()
      await page.getByRole("menuitem", { name: /b.example.*Member B/ }).click()
      await page.getByRole("button", { name: /Project B/ }).waitFor()
      const original = page.url()
      const appearance = await page.evaluate(() => [
        document.documentElement.lang,
        document.documentElement.dataset.colorScheme,
        getComputedStyle(document.documentElement).colorScheme,
      ])
      await page.evaluate(() => window.notificationFixture.emit("a"))
      const open = page.getByRole("button", { name: "Open session", exact: true })
      await open.waitFor({ timeout: 5000 })
      await page.locator('[data-component="toast"]').filter({ has: open }).hover()
      await open.hover()
      expect(page.url()).toBe(original)
      expect(
        await page.evaluate(() => [
          document.documentElement.lang,
          document.documentElement.dataset.colorScheme,
          getComputedStyle(document.documentElement).colorScheme,
        ]),
      ).toEqual(appearance)
      const bounds = await open.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(variant.width)
      if (process.env.SYNERGY_UI_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.SYNERGY_UI_SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({
          path: path.join(process.env.SYNERGY_UI_SCREENSHOT_DIR, `background-notification-${variant.width}.png`),
        })
      }
      await open.click()
      await page.waitForFunction(() =>
        window.notificationFixture.requests.some((item) => item.path.startsWith("/org/v1/sessions/session-a")),
      )
      expect(await page.evaluate(() => window.notificationFixture.navigations)).toContain(
        "/organization/org-a/account-a/deployment-a/projects/project-a/sessions/session-a",
      )
      expect(
        await page.evaluate(() =>
          window.notificationFixture.requests
            .filter((item) => item.path.startsWith("/org/v1/sessions/session-a"))
            .every((item) => item.connectionID === "a".repeat(64)),
        ),
      ).toBe(true)
      await page.getByRole("button", { name: "Current space" }).click()
      await page.getByRole("menuitem", { name: /b.example.*Member B/ }).click()
      await page.getByRole("button", { name: /Project B/ }).waitFor()
      await page.evaluate(() =>
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }),
      )
      await page.evaluate(() => window.notificationFixture.emit("a", "error"))
      await page.waitForFunction(() => window.notificationFixture.notifications.length === 1)
      await page.evaluate(() => window.notificationFixture.retire("a"))
      const before = page.url()
      await page.evaluate(() => window.notificationFixture.notifications[0].onclick?.())
      expect(page.url()).toBe(before)
      await page.locator('[data-component="toast"]').filter({ has: open }).hover()
      await open.hover()
      await page.getByRole("button", { name: "Open session", exact: true }).click()
      expect(page.url()).toBe(before)
      await page.evaluate(() => window.notificationFixture.emit("a"))
      expect(await page.evaluate(() => window.notificationFixture.notifications.length)).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }
}, 40_000)

test("the retained personal socket survives organization reading without body interests and retires delayed old Home replies", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  try {
    await page.goto(`${fixture.url}?mode=personal`)
    await page.getByTestId("personal-source").waitFor()
    await page.waitForFunction(() => window.notificationFixture.sockets.length === 1)
    const sourceKey = await page.getByTestId("personal-source").innerText()
    await page.getByRole("button", { name: "Switch B", exact: true }).click()
    await page.getByTestId("organization-reading").waitFor()
    await page.waitForFunction(() =>
      window.notificationFixture.sockets[0].sent.some(
        (value) => value.payload.type === "client.content.interests" && !value.payload.properties?.active,
      ),
    )
    await page.evaluate(() => window.notificationFixture.personal("complete"))
    const open = page.getByRole("button", { name: "Open session", exact: true })
    await page.locator('[data-component="toast"]').filter({ has: open }).hover()
    await open.hover()
    await open.click()
    await page.getByTestId("personal-source").waitFor()
    expect(await page.getByTestId("personal-source").innerText()).toBe(sourceKey)
    expect(await page.evaluate(() => window.notificationFixture.sockets.length)).toBe(1)
    await page.getByRole("button", { name: "Switch B", exact: true }).click()
    await page.evaluate(() => window.notificationFixture.personal("child"))
    await page.waitForFunction(() => window.notificationFixture.headers.some((value) => value.sessionID === "child"))
    expect(await page.getByRole("button", { name: "Open session", exact: true }).count()).toBe(0)
    await page.evaluate(() => {
      window.notificationFixture.holdHeaders(true)
      window.notificationFixture.personal("late", true)
    })
    await page.waitForFunction(() => window.notificationFixture.headers.some((value) => value.sessionID === "late"))
    await page.evaluate(() => window.notificationFixture.replacePersonal())
    await page.waitForFunction(
      () => window.notificationFixture.sockets.length === 2 && window.notificationFixture.sockets[0].readyState === 3,
    )
    await page.evaluate(() => window.notificationFixture.releaseHeaders())
    expect(await page.getByRole("button", { name: "Open session", exact: true }).count()).toBe(0)
    expect(
      await page.evaluate(
        () => window.notificationFixture.headers.find((value) => value.sessionID === "late")?.signal.aborted,
      ),
    ).toBe(true)
  } finally {
    await page.close()
  }
}, 30_000)

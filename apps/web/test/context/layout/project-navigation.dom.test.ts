import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let directory: string
let fixture: BrowserFixture
let browser: Browser
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".project-navigation-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "services.ts"),
    `
    import {createStore} from "solid-js/store"
    import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"
    const [state,setState]=createStore({scopes:[]})
    const counts={}
    const replies={}
    const held={}
    let receive
    const empty={items:[],total:0,nextCursor:null}
    const client=createSynergyClient({baseUrl:"http://navigation.test",fetch:async request=>{
      const url=new URL(request.url)
      if(url.pathname==="/scope" || url.pathname==="/scope/index")return Response.json([])
      if(url.pathname==="/global/nav/recent"){
        counts.recent=(counts.recent||0)+1
        return Response.json({...empty,...replies.recent,unreadCompletionCount:0})
      }
      if(url.pathname==="/session/index"){
        const id=url.searchParams.get("scopeID")
        counts[id]=(counts[id]||0)+1
        if(replies[id]==="hold")return await new Promise(resolve=>held[id]=resolve)
        if(replies[id]==="error")return Response.json({name:"StorageBusyError",data:{message:"Unavailable"}},{status:503})
        return Response.json(replies[id]||empty)
      }
      return Response.json({...empty,unreadCompletionCount:0})
    }})
    export const useGlobalSDK=()=>({url:"http://navigation.test",client,event:{listen:callback=>{receive=callback;return ()=>{receive=undefined}}}})
    export const useGlobalSync=()=>({data:{scope:[],config:{}},refreshScopes:async()=>{}})
    export const usePlatform=()=>({platform:"web"})
    export const useServer=()=>({url:"http://navigation.test",scopes:{list:()=>state.scopes,close:id=>setState("scopes",items=>items.filter(item=>item.id!==id))}})
    window.navigationFixture={
      counts,
      track:(id,expanded=true)=>setState("scopes",items=>[...items,{id,expanded}]),
      reply:(id,value)=>replies[id]=value,
      release:id=>held[id](Response.json(empty)),
      remove:id=>receive({details:{type:"scope.removed",properties:{id}}}),
      update:entry=>receive({details:{type:"session.updated",properties:{info:{id:entry.id,scope:{id:entry.scopeID},title:entry.title},navEntry:entry}}}),
      rename:()=>setState("scopes",items=>items.map(item=>({...item,name:"Renamed"}))),
    }
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {LayoutProvider,useLayout} from "/@fs/${source}/context/layout/index.tsx"
    function Read(){const layout=useLayout();Object.assign(window.navigationFixture,{
      ready:()=>layout.nav.scopeIndexLoaded(),
      load:id=>layout.nav.loadScopeNav(id),
      loadRecent:()=>layout.nav.retry(),
      snapshot:id=>({page:layout.nav.navEntries()[id],request:layout.nav.scopeRequestState?.(id)}),
    });return <div>Navigation fixture</div>}
    render(()=><LayoutProvider><Read/></LayoutProvider>,document.getElementById("root"))
  `,
  )
  fixture = await createBrowserFixture({
    root: directory,
    aliases: [
      ...["../global-sdk", "../global-sync", "../server", "../platform", "@/context/platform"].map((find) => ({
        find,
        replacement: path.join(directory, "services.ts"),
      })),
      { find: "@/", replacement: source + "/" },
    ],
  })
  browser = await chromium.launch({ headless: true })
}, 120000)

afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("metadata bursts update loaded rows without requests and retain a refresh behind an older read", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => Reflect.get(window, "navigationFixture").ready())
    const before = await page.evaluate(async () => {
      const f = Reflect.get(window, "navigationFixture")
      const entry = {
        id: "known",
        scopeID: "project",
        scopeType: "project",
        category: "project",
        title: "old",
        lastActivityAt: 1,
        pinned: 0,
        archived: false,
        completionNotice: { unread: false, unreadCount: 0 },
      }
      const list = { items: [entry], total: 1, nextCursor: null }
      f.reply("project", list)
      f.reply("recent", list)
      await Promise.all([f.load("project"), f.loadRecent()])
      f.entry = entry
      for (let i = 0; i < 20; i++) f.update({ ...entry, title: "updated" })
      return { project: f.counts.project, recent: f.counts.recent }
    })
    await page.waitForTimeout(400)
    expect(
      await page.evaluate(() => {
        const f = Reflect.get(window, "navigationFixture")
        return { project: f.counts.project, recent: f.counts.recent }
      }),
    ).toEqual(before)
    expect(
      await page.evaluate(() => Reflect.get(window, "navigationFixture").snapshot("project").page.items[0].title),
    ).toBe("updated")
    await page.evaluate(() => {
      const f = Reflect.get(window, "navigationFixture")
      f.reply("project", "hold")
      void f.load("project")
    })
    await page.waitForFunction(() => Reflect.get(window, "navigationFixture").snapshot("project").request.loading)
    await page.evaluate(() => {
      const f = Reflect.get(window, "navigationFixture")
      f.update({ ...f.entry, title: "newer" })
    })
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      const f = Reflect.get(window, "navigationFixture")
      f.reply("project", { items: [{ ...f.entry, title: "newer" }], total: 1, nextCursor: null })
      f.release("project")
    })
    await page.waitForFunction(
      () => Reflect.get(window, "navigationFixture").snapshot("project").page.items[0]?.title === "newer",
    )
    expect(await page.evaluate(() => Reflect.get(window, "navigationFixture").counts.project)).toBe(before.project + 2)
  } finally {
    await page.close()
  }
})

test("newly tracked expanded projects load once after shell startup, including empty lists", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => Reflect.get(window, "navigationFixture").ready())
    await page.evaluate(() => {
      const f = Reflect.get(window, "navigationFixture")
      f.track("created")
      f.track("collapsed", false)
    })
    await page.waitForFunction(
      () => Reflect.get(window, "navigationFixture").counts.created === 1,
      {},
      { timeout: 2000 },
    )
    expect(await page.evaluate(() => Reflect.get(window, "navigationFixture").snapshot("created"))).toEqual({
      page: { items: [], total: 0, nextCursor: null },
      request: { loading: false, loaded: true, error: false },
    })
    await page.evaluate(() => Reflect.get(window, "navigationFixture").rename())
    expect(
      await page.evaluate(() => {
        const counts = Reflect.get(window, "navigationFixture").counts
        return { created: counts.created, collapsed: counts.collapsed }
      }),
    ).toEqual({ created: 1, collapsed: undefined })
  } finally {
    await page.close()
  }
})

test("project requests settle failure, retry, and ignore a removed project's delayed response", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.waitForFunction(() => Reflect.get(window, "navigationFixture").ready())
    await page.evaluate(async () => {
      const f = Reflect.get(window, "navigationFixture")
      f.reply("failed", "error")
      await f.load("failed")
    })
    expect(await page.evaluate(() => Reflect.get(window, "navigationFixture").snapshot("failed"))).toEqual({
      page: undefined,
      request: { loading: false, loaded: false, error: true },
    })
    await page.evaluate(async () => {
      const f = Reflect.get(window, "navigationFixture")
      f.reply("failed", { items: [], total: 0, nextCursor: null })
      await f.load("failed")
    })
    expect(await page.evaluate(() => Reflect.get(window, "navigationFixture").snapshot("failed").request)).toEqual({
      loading: false,
      loaded: true,
      error: false,
    })
    await page.evaluate(async () => {
      const f = Reflect.get(window, "navigationFixture")
      f.reply("failed", "error")
      await f.load("failed")
    })
    expect(await page.evaluate(() => Reflect.get(window, "navigationFixture").snapshot("failed"))).toEqual({
      page: { items: [], total: 0, nextCursor: null },
      request: { loading: false, loaded: true, error: true },
    })
    await page.evaluate(() => {
      const f = Reflect.get(window, "navigationFixture")
      f.reply("removed", "hold")
      f.load("removed")
    })
    expect(
      await page.evaluate(() => Reflect.get(window, "navigationFixture").snapshot("removed").request?.loading),
    ).toBe(true)
    await page.evaluate(() => {
      const f = Reflect.get(window, "navigationFixture")
      f.remove("removed")
      f.release("removed")
    })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await page.evaluate(() => Reflect.get(window, "navigationFixture").snapshot("removed"))).toEqual({
      page: undefined,
      request: undefined,
    })
  } finally {
    await page.close()
  }
})

import { renderedTextContrast } from "../../testing/rendered-text-contrast"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

setDefaultTimeout(30000)

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let baseUrl: string
const errors: string[] = []
let formRequest: { scopeID: string | null; body: Record<string, unknown> } | undefined
let saveFailure = false
let historyFailure = false
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".agenda-interaction-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>#root{height:100vh}</style></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {Router,Route} from "@solidjs/router"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider, useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {Dialog} from "@ericsanchezok/synergy-ui/dialog"
    import {AgendaDetailActions} from ${JSON.stringify(`/@fs/${source}/components/agenda/detail-actions.tsx`)}
    import {AgendaFormDialog} from ${JSON.stringify(`/@fs/${source}/components/agenda/form.tsx`)}
    import {AgendaTaskList} from ${JSON.stringify(`/@fs/${source}/components/agenda/task-list.tsx`)}
    import {filterAgendaTasks} from ${JSON.stringify(`/@fs/${source}/components/agenda/forecast.ts`)}
    import {AgendaPanel} from ${JSON.stringify(`/@fs/${source}/components/agenda/panel.tsx`)}
    import {CalendarGrid} from ${JSON.stringify(`/@fs/${source}/components/agenda/calendar.tsx`)}
    import {MiniCalendar} from ${JSON.stringify(`/@fs/${source}/components/agenda/mini-calendar.tsx`)}
    import {ActivityView} from ${JSON.stringify(`/@fs/${source}/components/agenda/activity-view.tsx`)}
    import ${JSON.stringify(`/@fs/${source}/components/app-panel.css`)}
    import ${JSON.stringify(`/@fs/${source}/components/agenda/agenda-dialog.css`)}
    import {messages as en} from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import {messages as zh} from ${JSON.stringify(`/@fs/${source}/locales/zh-CN/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    const locale=new URLSearchParams(location.search).get("locale") || "en"
    const i18n=setupI18n({locale,messages:{en,"zh-CN":zh}})
    const items=[{id:"frequent",origin:{scope:{id:"home",type:"home"}}, title:"Frequent series",status:"active",triggers:[{type:"cron",expr:"0 9 * * 1"}],state:{nextRunAt:1900000000000,lastRunStatus:"error",lastRunAt:1000,lastRunError:"Timed out"}},{id:"todo",origin:{scope:{id:"home",type:"home"}},title:"Pending item",status:"pending"},{id:"paused",origin:{scope:{id:"home",type:"home"}},title:"Paused series",status:"paused",state:{lastRunAt:2000}}]

    function App(){
      const dialog=useDialog()
      if(new URLSearchParams(location.search).has("panel")) return <AgendaPanel/>
      if(new URLSearchParams(location.search).has("mini")) {
        const [anchor,setAnchor]=createSignal(new Date(2026,8,25).getTime())
        return <main><MiniCalendar anchor={anchor()} onDateClick={setAnchor}/></main>
      }
      if(new URLSearchParams(location.search).has("timegrid")) {
        const params=new URLSearchParams(location.search)
        const [mode,setMode]=createSignal(params.get("timegrid"))
        const [selected,setSelected]=createSignal("")
        const timeEvents=Array.from({length:7},(_,day)=>({id:"daily-"+day,itemId:"daily",title:"Anima daily wake",time:new Date(2026,8,21+day,3).getTime(),status:"active",triggerType:"cron"}))
        if(params.has("crowded")) for(const [index,minute] of [30,60,90].entries()) timeEvents.push({id:"nearby-"+index,itemId:"nearby",title:"A deliberately long scheduled title that must remain available when the calendar column is narrow",time:new Date(2026,8,25,3,minute).getTime(),status:"active",triggerType:"at"})
        timeEvents.push({id:"late",itemId:"late",title:"Last reminder before midnight",time:new Date(2026,8,25,23,55).getTime(),status:"active",triggerType:"at"})
        return <main style="padding:24px;height:100vh;display:flex;flex-direction:column"><CalendarGrid viewMode={mode()} onViewModeChange={setMode} anchor={new Date(2026,8,25).getTime()} events={timeEvents} onEventClick={event=>setSelected(event.id)}/><output>{selected()}</output></main>
      }
      if (new URLSearchParams(location.search).has("month")) {
        const [mode,setMode]=createSignal("month")
        const [anchor,setAnchor]=createSignal(new Date(2026,8,25).getTime())
        return <main style="padding:16px"><CalendarGrid viewMode={mode()} onViewModeChange={setMode} anchor={anchor()} onAnchorChange={setAnchor} events={[{id:"month-event",itemId:"item",title:"Full title for the selected day",time:new Date(2026,8,25,10).getTime(),status:"active",triggerType:"at"}]} /></main>
      }
      if (new URLSearchParams(location.search).has("activity")) {
        const [destination,setDestination]=createSignal("")
        const entry={agenda:{id:"history",title:"History fixture",status:"active"},run:{id:"run",status:"ok",trigger:{type:"manual"},time:{started:1000}},session:{id:"session-fixture",scopeID:"scope-target",title:"Run fixture"}}
        return <><ActivityView items={[entry]} total={1} hasMore={false} loading={false} query="" onQueryChange={() => {}} onLoadMore={() => {}} onNavigate={(session,scope) => setDestination(scope+":"+session)} onItemClick={() => {}}/><output>{destination()}</output></>
      }
      if (new URLSearchParams(location.search).has("actions")) return <button onClick={() => dialog.show(() => <Dialog title="Agenda details" footer={<AgendaDetailActions item={{id:"fixture",status:"active"}} isLoading={() => false} isDone={() => false} onAction={() => {}} _={descriptor => i18n._(descriptor)}/>}>Fixture</Dialog>)}>Open details</button>
      if (new URLSearchParams(location.search).has("form")) return <button onClick={() => dialog.show(() => <AgendaFormDialog directory="home" onClose={() => dialog.close()} />)}>New agenda</button>
      if (new URLSearchParams(location.search).has("edit")) return <button onClick={() => dialog.show(() => <AgendaFormDialog directory="scope-target" item={{id:"owned",title:"Original title",prompt:"Original content",status:"paused",triggers:[{type:"watch",watch:{kind:"file",glob:"src/**/*.ts",event:"change",debounce:"2s"}},{type:"cron",expr:"0 9 * * 1",tz:"Asia/Shanghai"}]}} onClose={() => dialog.close()} />)}>Edit agenda</button>
      const [selected,setSelected]=createSignal("");const [filter,setFilter]=createSignal("all");return <main style="padding:24px"><AgendaTaskList items={filterAgendaTasks(items,{query:"",scopeID:"",filter:filter()})} filter={filter()} onFilterChange={setFilter} scopeLabel={()=>"Home"} onClear={()=>setFilter("all")} filtered={filter()!=="all"} now={new Date(2026,8,25).getTime()} onSelect={(item)=>setSelected(item.id)}/><output>{selected()}</output></main>}
    render(()=> <I18nProvider i18n={i18n}><DialogProvider><Router><Route path="*" component={App}/></Router></DialogProvider></I18nProvider>,document.getElementById("root"))
  `,
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `
    import {useLingui} from "@lingui/solid"
    import {createIntlFormatter} from ${JSON.stringify(`/@fs/${source}/context/locale/formatter.ts`)}
    export const useLocale=()=>({i18n:useLingui().i18n(),fmt:createIntlFormatter(()=>new URLSearchParams(location.search).get("locale") || "en")})
  `,
  )
  await Bun.write(
    path.join(directory, "sdk.ts"),
    `
    import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"
    export const useGlobalSDK=()=>({client:createSynergyClient({baseUrl:location.origin+"/api"})})
  `,
  )
  await Bun.write(
    path.join(directory, "sync.ts"),
    `
    const created=new Date(2026,8,20).getTime();
    const rule=(id,title,status,triggers,scope="home")=>({id,title,status,triggers,prompt:"Controlled task content",createdBy:"user",origin:{scope:{id:scope,type:scope==="home"?"home":"project"}},time:{created,updated:created}});
    const agenda=[rule("daily","Anima daily wake","active",[{type:"cron",expr:"0 3 * * *",tz:"UTC"}]),rule("paused","Paused reminder","paused",[{type:"cron",expr:"0 9 * * *"}]),rule("manual","Manual task","pending",[]),rule("project","Project briefing","active",[{type:"cron",expr:"0 10 * * *"}],"scope-target")];
    export const useGlobalSync=()=>({agenda,data:{paths:{home:"home"},scope:[{id:"scope-target",name:"Target project",local:null}]},ensureScopeState:(id)=>[{scopeID:id}]})
  `,
  )
  await Bun.write(path.join(directory, "mobile-close.ts"), "export const useWorkspaceMobileHeaderClose=()=>()=>{}")
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        { find: "@/components/workspace/mobile-header-close", replacement: path.join(directory, "mobile-close.ts") },
        { find: "@/context/global-sdk", replacement: path.join(directory, "sdk.ts") },
        { find: "@/context/global-sync", replacement: path.join(directory, "sync.ts") },
        { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.setDefaultTimeout(10000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/agenda**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "GET") {
      if (url.pathname.endsWith("/activity")) {
        if (historyFailure) {
          await route.fulfill({ status: 503, json: { message: "History refresh failed" } })
          return
        }
        const query = url.searchParams.get("query") || ""
        if (query === "slow") await new Promise((resolve) => setTimeout(resolve, 350))
        await route.fulfill({
          status: 200,
          json: {
            items: [
              {
                agenda: { id: "daily", title: query ? query + " result" : "History fixture", status: "paused" },
                run: {
                  id: "run-" + query,
                  status: "ok",
                  trigger: { type: "manual" },
                  duration: 0,
                  time: { started: new Date(2026, 8, 25, 2).getTime() },
                },
              },
            ],
            total: 1,
            offset: 0,
            limit: 25,
            hasMore: false,
          },
        })
      } else await route.fulfill({ status: 200, json: [] })
      return
    }
    formRequest = { scopeID: url.searchParams.get("scopeID"), body: request.postDataJSON() }
    await route.fulfill({
      status: saveFailure ? 503 : 200,
      json: saveFailure ? { message: "Fixture save failed" } : { id: "created" },
    })
  })
}, 120000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("task rules remain date-free and preserve manual, disabled and unknown execution states", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Frequent series Enabled", exact: true }).waitFor()
  expect(await page.getByRole("article").count()).toBe(3)
  expect(await page.getByRole("button", { name: "Today", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Frequent series Enabled", exact: true }).press("Enter")
  expect(await page.getByRole("status").textContent()).toBe("frequent")
  expect(await page.getByText("No execution record", { exact: true }).count()).toBe(1)
  expect(await page.getByText("Result unavailable", { exact: true }).count()).toBe(1)
  await page.getByRole("radio", { name: "Last run failed", exact: true }).press("Space")
  expect(await page.getByRole("article").count()).toBe(1)
  expect(await page.getByText("Timed out", { exact: true }).count()).toBe(1)
  await page.getByRole("radio", { name: "Not enabled", exact: true }).press("Space")
  expect(await page.getByRole("button", { name: "Pending item Not enabled", exact: true }).count()).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test("the narrow calendar has one date picker and reachable view controls", async () => {
  await page.goto(baseUrl + "?month&locale=zh-CN")
  for (const name of ["今天", "上个月", "下个月", "列表", "日", "周", "月"]) {
    const control = ["列表", "日", "周", "月"].includes(name)
      ? page.getByRole("radio", { name, exact: true })
      : page.getByRole("button", { name, exact: true })
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  }
  await page.locator(".agenda-range-button").press("Enter")
  const picker = page.getByRole("dialog", { name: "选择日期", exact: true })
  await picker.waitFor()
  const selected = picker.locator('[data-mini-date][tabindex="0"]')
  await selected.press("ArrowRight")
  expect(await picker.isVisible()).toBe(true)
  await page.keyboard.press("Escape")
  await picker.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.classList.contains("agenda-range-button"))
})

test("trigger points keep titles and times readable across day, week and narrow layouts", async () => {
  for (const mode of ["day", "week"]) {
    await page.setViewportSize({ width: 1280, height: 812 })
    await page.goto(baseUrl + "?timegrid=" + mode)
    for (const width of [1280, 768, 375, 1280]) {
      await page.setViewportSize({ width, height: 812 })
      const event = page.locator(".agenda-occurrence:visible").filter({ hasText: "Anima daily wake" }).first()
      await event.scrollIntoViewIfNeeded()
      const geometry = await event.evaluate((button) => {
        const bounds = button.getBoundingClientRect()
        const time = button.querySelector("time")!.getBoundingClientRect()
        const title = button.querySelector(".app-panel-row-title")!
        return {
          timeFits: time.bottom <= bounds.bottom && time.top >= bounds.top,
          contentFits: button.scrollHeight <= button.clientHeight,
          font: getComputedStyle(title).fontSize,
          line: getComputedStyle(title).lineHeight,
        }
      })
      expect(geometry.timeFits).toBe(true)
      expect(geometry.contentFits).toBe(true)
      expect(geometry.font).toBe("14px")
      expect(geometry.line).toBe("20px")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  await page.setViewportSize({ width: 375, height: 812 })
})

test("dense trigger points stay separate and the last time of the day remains reachable", async () => {
  await page.setViewportSize({ width: 375, height: 650 })
  await page.goto(baseUrl + "?timegrid=week&crowded")
  const visible = page.locator(".agenda-occurrence:visible")
  await visible.first().waitFor()
  const bounds = await visible.evaluateAll((buttons) =>
    buttons.map((button) => {
      const r = button.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    }),
  )
  for (let index = 1; index < bounds.length; index++)
    expect(bounds[index]!.top).toBeGreaterThanOrEqual(bounds[index - 1]!.bottom)
  const long = visible.filter({ hasText: "A deliberately long" }).first()
  await long.focus()
  const tooltip = page.getByRole("tooltip")
  await tooltip.waitFor()
  expect(await tooltip.textContent()).toContain("must remain available when the calendar column is narrow")
  await page.keyboard.press("Escape")
  expect(await long.evaluate((button) => button === document.activeElement)).toBe(true)
  const late = visible.filter({ hasText: "Last reminder before midnight" })
  await late.scrollIntoViewIfNeeded()
  expect(await late.locator("time").textContent()).toBe("23:55")
  await late.press("Enter")
  expect(await page.getByRole("status").textContent()).toBe("late")
  expect(errors).toEqual([])
  await page.setViewportSize({ width: 375, height: 812 })
})

test("creating an agenda submits the chosen Scope and keeps inputs after a failed save", async () => {
  formRequest = undefined
  saveFailure = true
  await page.goto(`${baseUrl}?form`)
  await page.getByRole("button", { name: "New agenda", exact: true }).click()
  await page.waitForFunction(() => {
    const rect = document.querySelector('[role="dialog"]')?.getBoundingClientRect()
    return (
      rect &&
      Math.abs(rect.x) < 0.01 &&
      Math.abs(rect.y) < 0.01 &&
      Math.abs(rect.width - innerWidth) < 0.1 &&
      Math.abs(rect.height - innerHeight) < 0.1
    )
  })
  const formBounds = (await page.getByRole("dialog").boundingBox())!
  expect(formBounds.x).toBeCloseTo(0, 1)
  expect(formBounds.y).toBeCloseTo(0, 1)
  expect(formBounds.width).toBeCloseTo(375, 1)
  expect(formBounds.height).toBeCloseTo(812, 1)
  await page.getByPlaceholder("Add title", { exact: true }).fill("Scheduled check")
  await page.getByRole("button", { name: /Advanced settings/ }).click()
  await page.getByRole("button", { name: /^Scope:/ }).click()
  await page.getByRole("option", { name: /Target project/ }).click()
  await page.getByRole("listbox", { name: "Scope", exact: true }).waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByText("Fixture save failed", { exact: true }).waitFor()
  const recordedRequest = () => formRequest
  expect(recordedRequest()?.scopeID).toBe("scope-target")
  expect(await page.getByPlaceholder("Add title", { exact: true }).inputValue()).toBe("Scheduled check")
  saveFailure = false
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByRole("dialog", { name: "New task", exact: true }).waitFor({ state: "detached" })
})

test("editing preserves the owning Scope and triggers the schedule form cannot express", async () => {
  formRequest = undefined
  saveFailure = true
  try {
    await page.goto(`${baseUrl}?edit`)
    await page.getByRole("button", { name: "Edit agenda", exact: true }).click()
    const title = page.getByPlaceholder("Add title", { exact: true })
    await title.fill("Updated title")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByText("Fixture save failed", { exact: true }).waitFor()
    const recordedRequest = () => formRequest
    expect(recordedRequest()?.scopeID).toBe("scope-target")
    expect(recordedRequest()?.body.triggers).toEqual([
      { type: "watch", watch: { kind: "file", glob: "src/**/*.ts", event: "change", debounce: "2s" } },
      { type: "cron", expr: "0 9 * * 1", tz: "Asia/Shanghai" },
    ])
    expect(await title.inputValue()).toBe("Updated title")
    saveFailure = false
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "detached" })
  } finally {
    saveFailure = false
  }
})

test("dismissing a changed agenda asks before discarding and keeps the underlying form", async () => {
  await page.goto(`${baseUrl}?form`)
  await page.getByRole("button", { name: "New agenda", exact: true }).click()
  await page.getByPlaceholder("Add title", { exact: true }).fill("Keep this draft")
  await page.keyboard.press("Escape")
  const confirm = page.getByRole("dialog", { name: "Discard changes?", exact: true })
  await confirm.waitFor()
  await confirm.getByRole("button", { name: "Keep editing", exact: true }).click()
  expect(await page.getByPlaceholder("Add title", { exact: true }).inputValue()).toBe("Keep this draft")
  await page.getByRole("button", { name: "Close dialog", exact: true }).click()
  await confirm.getByRole("button", { name: "Discard changes", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction(() => document.activeElement?.textContent === "New agenda")
  expect(
    await page.getByRole("button", { name: "New agenda", exact: true }).evaluate((el) => el === document.activeElement),
  ).toBe(true)
})

test("schedule actions have clear names and phone targets while task content uses reading typography", async () => {
  await page.setViewportSize({ width: 375, height: 650 })
  await page.goto(`${baseUrl}?form`)
  await page.getByRole("button", { name: "New agenda", exact: true }).click()
  await page.getByRole("dialog").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    )
  })
  const content = page.getByRole("textbox", { name: "Prompt", exact: true })
  expect(await content.evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px")
  const removeTime = page.getByRole("button", { name: "Remove scheduled time", exact: true })
  expect((await removeTime.boundingBox())!.width).toBeGreaterThanOrEqual(44)
  expect((await removeTime.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await removeTime.press("Enter")
  const addTime = page.getByRole("button", { name: "Add time", exact: true })
  expect(await addTime.isVisible()).toBe(true)
  expect((await addTime.boundingBox())!.height).toBeGreaterThanOrEqual(44)
})

test("tasks show trigger conditions and only enabled next times, with filter recovery", async () => {
  await page.goto(baseUrl)
  const row = page.locator("article").filter({ hasText: "Frequent series" })
  expect(await row.getByText(/Every Monday at 09:00/).isVisible()).toBe(true)
  expect(await row.getByText(/^Next:/).isVisible()).toBe(true)
  expect(
    await page
      .locator("article")
      .filter({ hasText: "Paused series" })
      .getByText(/^Next:/)
      .count(),
  ).toBe(0)
  await page.getByRole("radio", { name: "Last run failed", exact: true }).press("Space")
  expect(await page.locator("article").count()).toBe(1)
  await page.getByRole("button", { name: "Clear filters", exact: true }).click()
  expect(await page.locator("article").count()).toBe(3)
})

test("secondary agenda actions dismiss before their owning detail dialog", async () => {
  await page.goto(`${baseUrl}?actions`)
  await page.getByRole("button", { name: "Open details", exact: true }).click()
  await page.getByRole("button", { name: "More actions", exact: true }).press("Enter")
  const menu = page.getByRole("dialog", { name: "More actions", exact: true })
  await menu.waitFor()
  expect(await menu.getByRole("button", { name: "Delete", exact: true }).isVisible()).toBe(true)
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "More actions")
  expect(await page.getByRole("dialog", { name: "Agenda details", exact: true }).isVisible()).toBe(true)
  expect(
    await page
      .getByRole("button", { name: "More actions", exact: true })
      .evaluate((el) => el === document.activeElement),
  ).toBe(true)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
})

test("execution history groups actual dates and separates rule details from conversation navigation", async () => {
  await page.goto(baseUrl + "?activity")
  const open = page.getByRole("button", { name: "Open conversation", exact: true })
  await open.press("Enter")
  expect(await page.getByRole("status").textContent()).toBe("scope-target:session-fixture")
  expect(await page.getByRole("heading", { name: "Thursday, January 1, 1970", exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole("button", { name: "History fixture", exact: true }).isVisible()).toBe(true)
  expect(await page.getByText("Enabled", { exact: true }).count()).toBe(0)
})

test("phone month overview retains its mode and exposes a readable selected-day list", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${baseUrl}?month`)
  const date = page.getByRole("button", { name: "Friday, September 25, 2026", exact: true })
  await date.click()
  expect(await page.getByRole("radio", { name: "Month", exact: true }).isChecked()).toBe(true)
  expect(
    await page
      .locator(".agenda-month-day-list")
      .getByText("Full title for the selected day", { exact: true })
      .isVisible(),
  ).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1280, height: 800 })
  expect(await date.getAttribute("aria-pressed")).toBe("true")
  await page.setViewportSize({ width: 375, height: 812 })
  expect(
    await page
      .locator(".agenda-month-day-list")
      .getByText("Full title for the selected day", { exact: true })
      .isVisible(),
  ).toBe(true)
})

test("month navigation keeps a reachable date and arrow keys select with a full date name", async () => {
  await page.goto(`${baseUrl}?mini`)
  await page.getByRole("button", { name: "Next month", exact: true }).click()
  const entry = page.locator('[data-mini-date][tabindex="0"]')
  expect(await entry.count()).toBe(1)
  await entry.press("ArrowRight")
  expect(
    await page.getByRole("button", { name: "Monday, October 26, 2026", exact: true }).getAttribute("aria-pressed"),
  ).toBe("true")
})

test("neighboring month dates and form hints stay readable on their actual surfaces", async () => {
  await page.goto(`${baseUrl}?mini`)
  const date = page.getByRole("button", { name: "Sunday, August 30, 2026", exact: true })
  await date.waitFor()
  expect(await renderedTextContrast(date)).toBeGreaterThanOrEqual(4.5)
  await page.goto(`${baseUrl}?form`)
  await page.getByRole("button", { name: "New agenda", exact: true }).click()
  expect(
    await renderedTextContrast(page.getByRole("textbox", { name: "Title", exact: true }), "::placeholder"),
  ).toBeGreaterThanOrEqual(4.5)
})

test("the composed Agenda separates future occurrences from rule management and restores clicked-time context", async () => {
  await page.clock.setFixedTime(new Date(2026, 8, 25, 0))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(baseUrl + "?panel")
  await page.getByRole("tab", { name: "Arrangements", exact: true }).waitFor()
  expect(await page.getByRole("tab", { name: "Arrangements", exact: true }).getAttribute("aria-selected")).toBe("true")
  expect(await page.getByText("Manual task", { exact: true }).count()).toBe(0)
  expect(await page.getByText("Paused reminder", { exact: true }).count()).toBe(0)
  const first = page.locator(".agenda-occurrence").filter({ hasText: "Anima daily wake" }).first()
  await first.press("Enter")
  const detail = page.getByRole("dialog", { name: "Anima daily wake", exact: true })
  await detail.waitFor()
  expect(await detail.getByText("Expected trigger", { exact: true }).isVisible()).toBe(true)
  expect(await detail.locator(".agenda-occurrence-detail time").getAttribute("datetime")).toBe(
    new Date(2026, 8, 25, 3).toISOString(),
  )
  await page.keyboard.press("Escape")
  await detail.waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.classList.contains("agenda-occurrence"))
  expect(await first.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.getByRole("tab", { name: "Tasks", exact: true }).press("Enter")
  expect(await page.locator(".agenda-task-row").count()).toBe(4)
  expect(await page.getByRole("button", { name: "Today", exact: true }).count()).toBe(0)
  const search = page.getByRole("textbox", { name: "Search tasks", exact: true })
  await search.fill("Manual")
  const manual = page.locator(".agenda-task-row").filter({ hasText: "Manual task" })
  expect(await manual.getByText("Manual execution", { exact: false }).isVisible()).toBe(true)
  expect(await manual.getByRole("button", { name: "Enable and run now", exact: true }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "Clear search", exact: true }).press("Enter")
  expect(await search.evaluate((element) => element === document.activeElement)).toBe(true)
  expect(await page.locator(".agenda-task-row").count()).toBe(4)
  await page.getByRole("button", { name: "Scope: All Scopes", exact: true }).click()
  await page.getByRole("option", { name: "Target project", exact: true }).click()
  expect(await page.locator(".agenda-task-row").count()).toBe(1)
  expect(await page.getByRole("button", { name: "Project briefing Enabled", exact: true }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "Clear filters", exact: true }).first().click()
  expect(await page.locator(".agenda-task-row").count()).toBe(4)
  expect(errors).toEqual([])
})

test("one selected date survives date-picker navigation, view changes, tabs and responsive transitions", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(baseUrl + "?panel")
  await page.locator(".agenda-range-button").press("Enter")
  const picker = page.getByRole("dialog", { name: "Choose a date", exact: true })
  await picker.waitFor()
  const current = picker.getByRole("button", { name: "Friday, September 25, 2026", exact: true })
  await current.press("ArrowRight")
  const selected = picker.getByRole("button", { name: "Saturday, September 26, 2026", exact: true })
  expect(await selected.getAttribute("aria-pressed")).toBe("true")
  await selected.press("Enter")
  await picker.waitFor({ state: "detached" })
  expect(await page.locator(".agenda-range-button").textContent()).toContain("Sep 26")
  await page.getByRole("tab", { name: "Tasks", exact: true }).click()
  await page.getByRole("tab", { name: "Arrangements", exact: true }).click()
  expect(await page.locator(".agenda-range-button").textContent()).toContain("Sep 26")
  await page.getByRole("radio", { name: "Month", exact: true }).press("Space")
  const date = page.getByRole("button", { name: "Saturday, September 26, 2026", exact: true })
  expect(await date.getAttribute("aria-pressed")).toBe("true")
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 812 })
    expect(await date.getAttribute("aria-pressed")).toBe("true")
    expect(await page.getByRole("radio", { name: "Month", exact: true }).isChecked()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.getByRole("radio", { name: "Week", exact: true }).press("Space")
  expect(await page.locator(".agenda-week-date[aria-pressed=true]").innerText()).toContain("26")
  expect(await page.locator(".agenda-week-day-list").getByText("Anima daily wake", { exact: true }).isVisible()).toBe(
    true,
  )
  await page.getByRole("radio", { name: "Day", exact: true }).press("Space")
  expect(await page.locator(".agenda-day-agenda").getByText("Anima daily wake", { exact: true }).isVisible()).toBe(true)
})

test("history accepts results only for the current query and keeps records through a failed refresh", async () => {
  await page.goto(baseUrl + "?panel")
  await page.getByRole("tab", { name: "History", exact: true }).click()
  await page.getByRole("button", { name: "History fixture", exact: true }).waitFor()
  const search = page.getByRole("textbox")
  const heldRequest = page.waitForRequest((request) => new URL(request.url()).searchParams.get("query") === "slow")
  const heldResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get("query") === "slow")
  await search.fill("slow")
  await heldRequest
  await search.fill("fast")
  await page.getByRole("button", { name: "fast result", exact: true }).waitFor()
  await heldResponse
  expect(await page.getByRole("button", { name: "slow result", exact: true }).count()).toBe(0)
  expect(await page.getByRole("button", { name: "fast result", exact: true }).isVisible()).toBe(true)
  historyFailure = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await page.getByRole("alert").waitFor()
  expect(await page.getByRole("button", { name: "fast result", exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole("button", { name: "Retry", exact: true }).isVisible()).toBe(true)
  historyFailure = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByRole("alert").waitFor({ state: "detached" })
  expect(await page.getByText("0ms", { exact: true }).isVisible()).toBe(true)
  expect(await page.getByText("Paused", { exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Clear search", exact: true }).press("Enter")
  expect(await search.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.getByRole("button", { name: "History fixture", exact: true }).waitFor()
})

test("past dates lead to actual history rather than invented past calendar executions", async () => {
  await page.goto(baseUrl + "?panel")
  await page.getByRole("button", { name: "Previous 7 days", exact: true }).click()
  expect(await page.locator(".agenda-occurrence").count()).toBe(0)
  await page.getByRole("button", { name: "View execution history", exact: true }).press("Enter")
  expect(await page.getByRole("tab", { name: "History", exact: true }).getAttribute("aria-selected")).toBe("true")
  expect(await page.getByRole("button", { name: "Today", exact: true }).count()).toBe(0)
})

test("phone Agenda actions keep usable touch targets and the primary icon stays visible", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(baseUrl + "?panel")
  const create = page.getByRole("button", { name: "New task", exact: true })
  await create.waitFor()
  expect(await renderedTextContrast(create.locator('[data-component="icon"]'))).toBeGreaterThanOrEqual(3)
  await page.getByRole("tab", { name: "Tasks", exact: true }).click()
  const manual = page.locator(".agenda-task-row").filter({ hasText: "Manual task" })
  const action = manual.getByRole("button", { name: "Enable and run now", exact: true })
  expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.getByRole("tab", { name: "Arrangements", exact: true }).click()
  expect(
    await page.locator(".agenda-range-button").evaluate((element) =>
      Math.max(
        ...getComputedStyle(element)
          .transitionDuration.split(",")
          .map((value) => parseFloat(value)),
      ),
    ),
  ).toBeLessThanOrEqual(0.001)
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("Scope filters use a themed listbox with keyboard selection and focus return", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(baseUrl + "?panel")
  const trigger = page.getByRole("button", { name: "Scope: All Scopes", exact: true })
  expect(await trigger.count()).toBe(1)
  await trigger.press("ArrowDown")
  const options = page.getByRole("listbox", { name: "Scope", exact: true })
  await options.waitFor()
  const allScopes = options.getByRole("option", { name: "All Scopes", exact: true })
  await page.waitForFunction((element) => element === document.activeElement, await allScopes.elementHandle())
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  const project = options.getByRole("option", { name: "Target project", exact: true })
  expect(await project.evaluate((element) => element === document.activeElement)).toBe(true)
  expect(await project.getAttribute("aria-selected")).toBe("false")
  expect(await trigger.getAttribute("aria-label")).toBe("Scope: All Scopes")
  await page.keyboard.press("Enter")
  await options.waitFor({ state: "detached" })
  const selected = page.getByRole("button", { name: "Scope: Target project", exact: true })
  await page.waitForFunction((element) => element === document.activeElement, await selected.elementHandle())
  await selected.press("Space")
  expect(await page.getByRole("option", { name: "Target project", exact: true }).getAttribute("aria-selected")).toBe(
    "true",
  )
  await page.keyboard.press("Escape")
  await options.waitFor({ state: "detached" })
  await page.waitForFunction((element) => element === document.activeElement, await selected.elementHandle())
  expect(await selected.evaluate((element) => element === document.activeElement)).toBe(true)
})

test("creating from a selected Scope keeps that context without changing an existing task owner", async () => {
  const received = () => formRequest
  formRequest = undefined
  saveFailure = false
  await page.goto(baseUrl + "?panel")
  await page.getByRole("button", { name: "Scope: All Scopes", exact: true }).click()
  await page.getByRole("option", { name: "Target project", exact: true }).click()
  await page.getByRole("button", { name: "New task", exact: true }).click()
  await page.getByPlaceholder("Add title", { exact: true }).fill("Scoped new task")
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  expect(received()?.scopeID).toBe("scope-target")
})

test("peer destinations keep independent scroll positions so a new destination exposes its controls", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(baseUrl + "?panel")
  await page.getByRole("radio", { name: "Month", exact: true }).press("Space")
  const arrangements = page.getByRole("tabpanel", { name: "Arrangements", exact: true })
  await arrangements.evaluate((element) => {
    element.scrollTop = 240
  })
  const arrangementPosition = await arrangements.evaluate((element) => element.scrollTop)
  expect(arrangementPosition).toBeGreaterThan(0)
  await page.getByRole("tab", { name: "Tasks", exact: true }).press("Enter")
  const tasks = page.getByRole("tabpanel", { name: "Tasks", exact: true })
  await page.waitForFunction(() => document.querySelector('[role="tabpanel"]')?.scrollTop === 0, undefined, {
    timeout: 1000,
  })
  expect(await tasks.evaluate((element) => element.scrollTop)).toBe(0)
  await tasks.evaluate((element) => {
    element.scrollTop = 100
  })
  const taskPosition = await tasks.evaluate((element) => element.scrollTop)
  expect(taskPosition).toBeGreaterThan(0)
  await page.getByRole("tab", { name: "Arrangements", exact: true }).press("Enter")
  await page.waitForFunction(
    (position) => document.querySelector('[role="tabpanel"]')?.scrollTop === position,
    arrangementPosition,
    { timeout: 1000 },
  )
  expect(await arrangements.evaluate((element) => element.scrollTop)).toBe(arrangementPosition)
  await page.getByRole("tab", { name: "Tasks", exact: true }).press("Enter")
  await page.waitForFunction(
    (position) => document.querySelector('[role="tabpanel"]')?.scrollTop === position,
    taskPosition,
    { timeout: 1000 },
  )
  expect(await tasks.evaluate((element) => element.scrollTop)).toBe(taskPosition)
})

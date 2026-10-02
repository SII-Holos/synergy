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
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".agenda-series-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {DialogProvider, useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {Dialog} from "@ericsanchezok/synergy-ui/dialog"
    import {AgendaDetailActions} from ${JSON.stringify(`/@fs/${source}/components/agenda/detail-actions.tsx`)}
    import {AgendaFormDialog} from ${JSON.stringify(`/@fs/${source}/components/agenda/form.tsx`)}
    import {AgendaSeriesList} from ${JSON.stringify(`/@fs/${source}/components/agenda/series-list.tsx`)}
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
    const items=[{id:"frequent", title:"Frequent series",status:"active",triggers:[{type:"cron",expr:"0 9 * * 1"}],state:{nextRunAt:1900000000000,lastRunStatus:"error",lastRunAt:1000,lastRunError:"Timed out"}},{id:"todo",title:"Pending item",status:"pending"},{id:"paused",title:"Paused series",status:"paused",state:{lastRunAt:2000}}]
    const events=Array.from({length:200},(_,i)=>({id:String(i),itemId:"frequent",time:i*60000}))
    function App(){
      const dialog=useDialog()
      if(new URLSearchParams(location.search).has("mini")) {
        const [anchor,setAnchor]=createSignal(new Date(2026,8,25).getTime())
        return <main><MiniCalendar anchor={anchor()} viewMode="day" onDateClick={setAnchor}/></main>
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
      const [selected,setSelected]=createSignal("");return <main style="padding:24px"><CalendarGrid viewMode="list" anchor={new Date(2026,8,25).getTime()} events={[]} listContent={<AgendaSeriesList items={items} events={events} onSelect={(item)=>setSelected(item.id)}/>}/><output>{selected()}</output></main>}
    render(()=> <I18nProvider i18n={i18n}><DialogProvider><App/></DialogProvider></I18nProvider>,document.getElementById("root"))
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
    export const useGlobalSync=()=>({data:{paths:{home:"home"},scope:[{id:"scope-target",name:"Target project",local:null}]},ensureScopeState:(id)=>[{scopeID:id}]})
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
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
    formRequest = { scopeID: new URL(request.url()).searchParams.get("scopeID"), body: request.postDataJSON() }
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

test("a dense series stays one row, exposes planned times and keeps unknown run states distinct", async () => {
  await page.goto(baseUrl)
  await page.getByRole("button", { name: "Frequent series Active", exact: true }).waitFor({ timeout: 3000 })
  expect(await page.getByRole("article").count()).toBe(3)
  const frequent = page.getByRole("button", { name: "Frequent series Active", exact: true })
  await frequent.press("Enter")
  expect(await page.getByRole("status").textContent()).toBe("frequent")
  await page.getByText("Preview 200 planned times", { exact: true }).click()
  expect(await page.getByRole("listitem").count()).toBe(200)
  expect(await page.getByText("No run record available", { exact: true }).count()).toBe(1)
  expect(await page.getByText("Latest run status unavailable", { exact: true }).count()).toBe(1)
  await page.getByRole("radio", { name: "Last run failed", exact: true }).press("Space")
  expect(await page.getByRole("article").count()).toBe(1)
  expect(await page.getByText("Timed out", { exact: true }).count()).toBe(1)
  await page.getByRole("radio", { name: "Pending", exact: true }).press("Space")
  expect(await page.getByRole("article").count()).toBe(1)
  expect(await page.getByRole("button", { name: "Pending item Pending", exact: true }).count()).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  expect(errors).toEqual([])
})

test("the narrow calendar toolbar keeps its date range and view controls readable", async () => {
  await page.goto(baseUrl + "?locale=zh-CN")
  const title = page.locator(".agenda-calendar-toolbar > span")
  await title.waitFor({ state: "visible" })
  expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  for (const name of ["今天", "上一时间范围", "下一时间范围", "列表", "日", "周", "月"]) {
    const box = await (
      ["列表", "日", "周", "月"].includes(name)
        ? page.getByText(name, { exact: true }).first()
        : page.getByRole("button", { name, exact: true })
    ).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  }
})

test("day and week events keep their wrapped title and full start time inside the card", async () => {
  for (const mode of ["day", "week"]) {
    await page.setViewportSize({ width: 1280, height: 812 })
    await page.goto(`${baseUrl}?timegrid=${mode}`)
    const event = page.locator(".agenda-event-surface").filter({ hasText: "Anima daily wake" }).first()
    for (const width of [1280, 768, 375, 1280]) {
      await page.setViewportSize({ width, height: 812 })
      await event.scrollIntoViewIfNeeded()
      const geometry = await event.evaluate((button) => {
        const card = button.getBoundingClientRect()
        const title = button.firstElementChild!
        const time = button.lastElementChild!.getBoundingClientRect()
        const style = getComputedStyle(title)
        return {
          timeFits: time.bottom <= card.bottom - 1 && time.top >= card.top,
          contentFits: button.scrollHeight <= button.clientHeight,
          titleFits: title.scrollHeight <= title.clientHeight,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        }
      })
      expect(geometry.timeFits).toBe(true)
      expect(geometry.contentFits).toBe(true)
      expect(geometry.titleFits).toBe(true)
      expect(geometry.fontSize).toBe("14px")
      expect(geometry.lineHeight).toBe("20px")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await event.press("Enter")
    expect(await page.getByRole("status").textContent()).toBe(mode === "day" ? "daily-4" : "daily-0")
  }
})

test("nearby calendar cards do not cover each other and a late event remains fully scrollable", async () => {
  await page.setViewportSize({ width: 768, height: 650 })
  await page.goto(`${baseUrl}?timegrid=week&crowded`)
  await page.locator(".agenda-event-surface").first().waitFor()
  const columns = await page.locator(".agenda-day-column").evaluateAll((elements) =>
    elements.map((column) =>
      Array.from(column.querySelectorAll(".agenda-event-surface")).map((button) => {
        const rect = button.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      }),
    ),
  )
  for (const cards of columns) {
    for (const [index, first] of cards.entries()) {
      for (const second of cards.slice(index + 1)) {
        expect(
          first.right <= second.left ||
            second.right <= first.left ||
            first.bottom <= second.top ||
            second.bottom <= first.top,
        ).toBe(true)
      }
    }
  }
  const longEvent = page.locator(".agenda-event-surface").filter({ hasText: "A deliberately long" }).first()
  await longEvent.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await longEvent.focus()
  const tooltip = page.getByRole("tooltip")
  await tooltip.waitFor()
  expect(await tooltip.textContent()).toContain("must remain available when the calendar column is narrow")
  expect(await page.locator('.agenda-day-column [tabindex="0"]:not(button)').count()).toBe(0)
  await page.keyboard.press("Escape")
  expect(await longEvent.evaluate((button) => button === document.activeElement)).toBe(true)
  const alignment = await page.locator(".agenda-grid-scroll").evaluate((scroller) => {
    scroller.scrollLeft = 180
    const header = scroller.querySelector(".agenda-day-header-cell")!.getBoundingClientRect()
    const column = scroller.querySelector(".agenda-day-column")!.getBoundingClientRect()
    return { header: header.left, column: column.left }
  })
  expect(alignment.header).toBeCloseTo(alignment.column, 1)
  const late = page.locator(".agenda-event-surface").filter({ hasText: "Last reminder before midnight" })
  await late.scrollIntoViewIfNeeded()
  expect(
    await late.evaluate((button) => {
      const rect = button.getBoundingClientRect()
      const viewport = button.closest(".agenda-grid-scroll")!.getBoundingClientRect()
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom
    }),
  ).toBe(true)
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
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByText("Fixture save failed", { exact: true }).waitFor()
  const recordedRequest = () => formRequest
  expect(recordedRequest()?.scopeID).toBe("scope-target")
  expect(await page.getByPlaceholder("Add title", { exact: true }).inputValue()).toBe("Scheduled check")
  saveFailure = false
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
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

test("series shows its trigger and next scheduled time and exposes filter recovery", async () => {
  await page.goto(baseUrl)
  const series = page.locator("article").filter({ hasText: "Frequent series" })
  expect(await series.getByText(/Every Monday at 09:00/).isVisible()).toBe(true)
  expect(await series.getByText(/^Next run:/).isVisible()).toBe(true)
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

test("execution history exposes keyboard navigation and independent group disclosure", async () => {
  await page.goto(`${baseUrl}?activity`)
  const run = page.getByRole("button", { name: /Run fixture/ })
  await run.waitFor()
  await run.press("Enter")
  expect(await page.getByRole("status").textContent()).toBe("scope-target:session-fixture")
  const group = page.getByRole("button", { name: "History fixture Active", exact: true })
  await group.press("Enter")
  expect(await group.getAttribute("aria-expanded")).toBe("false")
  expect(await page.getByRole("button", { name: /Run fixture/ }).count()).toBe(0)
  await group.press("Enter")
  expect(await page.getByRole("button", { name: /Run fixture/ }).count()).toBe(1)
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

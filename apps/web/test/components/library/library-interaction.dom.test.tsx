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
let url: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
let detailFailure = true
let memoryFailure = false
let detailReads = 0
let removedMemory = false
let multipleMemories = false
let holdMemory: Promise<void> | undefined
const memory = {
  id: "memory",
  title: "Project testing",
  content: "Run focused behavior tests",
  category: "coding",
  recallMode: "contextual",
  createdAt: 1,
  updatedAt: 3,
}
const experience = {
  id: "failed",
  intent: "",
  rewardStatus: "encoding_failed",
  sessionID: "session-source",
  scopeID: "scope-source",
  sourceProviderID: "provider",
  sourceModelID: "model",
  reward: null,
  rewards: {},
  qValue: 0,
  qValues: {},
  qVisits: 0,
  turnsRemaining: null,
  createdAt: 1,
  updatedAt: 4,
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".library-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<style>*{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `
    import {useLingui} from "@lingui/solid"
    import {createIntlFormatter} from "/@fs/${source}/context/locale/formatter.ts"
    export function useLocale() { const {i18n} = useLingui(); return {i18n: i18n(), fmt: createIntlFormatter(() => "en")} }
  `,
  )
  await Bun.write(path.join(directory, "markdown.tsx"), "export const Markdown = props => <div>{props.text}</div>")
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal, Show, Suspense} from "solid-js"
    import {Router} from "@solidjs/router"
    import {setupI18n} from "@lingui/core"
    import {I18nProvider} from "@lingui/solid"
    import {createSynergyClient} from "@ericsanchezok/synergy-sdk/client"
    import {AppPanel} from "/@fs/${source}/components/app-panel.tsx"
    import {RankList} from "/@fs/${source}/components/stats/rank-list.tsx"
    import {MODEL_METRICS} from "/@fs/${source}/components/stats/model.ts"
    import {DialogProvider} from "@ericsanchezok/synergy-ui/context/dialog"
    import {ExperienceCard} from "/@fs/${source}/components/library/experience-view.tsx"
    import {MemoryView, MemoryCard} from "/@fs/${source}/components/library/memory-view.tsx"
    import {LibraryHome} from "/@fs/${source}/components/library/home-view.tsx"
    import {CalendarGrid} from "/@fs/${source}/components/agenda/calendar.tsx"
    import {messages as en} from "/@fs/${source}/locales/en/messages.po"
    import "@ericsanchezok/synergy-ui/styles"
    import "/@fs/${source}/index.css"
    import "/@fs/${source}/components/library/library-panel.css"
    import "/@fs/${source}/components/agenda/agenda-dialog.css"
    const i18n=setupI18n({locale: "en", messages: {en}})
    const sdk={client:createSynergyClient({baseUrl: location.origin + "/api",throwOnError:true})}
    function Fixture() {
      if (new URLSearchParams(location.search).has("remove")) return <AppPanel.Root><AppPanel.Content><input aria-label="Search library"/><MemoryView sdk={sdk} search="" isSearching={false} setSearchError={()=>{}} refetchStats={()=>{}}/></AppPanel.Content></AppPanel.Root>

      if (new URLSearchParams(location.search).has("preview")) return <ExperienceCard item={{...${JSON.stringify(experience)},intent:"First useful paragraph\\n\\nFurther context to read in the summary",rewardStatus:"evaluated",reward:0}} expanded={false} searching={false} selecting={false} selected={false} detailError={false} expandedSections={new Set()} onRetry={() => {}} onToggle={() => {}} onToggleSection={() => {}} />
      if (new URLSearchParams(location.search).has("rank")) return <RankList title="Models" description="Model usage" metrics={MODEL_METRICS} rows={[{id:"model",label:"Example model",primary:"embedding",values:{messages:3,tokens:3,cost:0}}]} defaultMetric="messages" />
      if (new URLSearchParams(location.search).has("typography")) return <AppPanel.Root><AppPanel.Content><AppPanel.Header><AppPanel.HeaderRow><AppPanel.Title>Library</AppPanel.Title></AppPanel.HeaderRow><AppPanel.Subtitle>Supporting information</AppPanel.Subtitle></AppPanel.Header><AppPanel.Body><p>Reading content</p></AppPanel.Body></AppPanel.Content></AppPanel.Root>
      const [selected,setSelected]=createSignal(false)
      const [memorySelected,setMemorySelected]=createSignal(false)
      const [query,setQuery]=createSignal("")
      const [nav,setNav]=createSignal("home")
      const [calendar,setCalendar]=createSignal(false)
      const [mode,setMode]=createSignal("week")
      const [opened,setOpened]=createSignal("")
      const [anchor,setAnchor]=createSignal(new Date(2026,8,25).getTime())
      if (new URLSearchParams(location.search).has("selection")) return <>
        <section aria-label="Experience selection"><ExperienceCard item={${JSON.stringify(experience)}} expanded={false} searching={false} selecting={true} selected={selected()} detailError={false} expandedSections={new Set()} onRetry={() => {}} onToggle={() => setSelected(value => !value)} onToggleSection={() => {}} /></section>
        <section aria-label="Memory selection"><MemoryCard item={${JSON.stringify(memory)}} expanded={false} searching={false} selecting={true} selected={memorySelected()} onToggle={() => setMemorySelected(value => !value)} /></section>
      </>
      return <><button onClick={() => setCalendar(value => !value)}>Toggle calendar</button>
      <Show when={calendar()} fallback={<><div class="library-header-controls library-header-home"><AppPanel.Tabs label="Library views" items={[{id:"home",label:"Home"},{id:"memory",label:"Memories 100"},{id:"experience",label:"Experiences 120"},{id:"skill",label:"Skills"},{id:"stats",label:"Statistics"}]} active={nav()} onChange={setNav} /><div class="library-search-field"><input aria-label="Search library" style={{"flex":"1", "width":"100%"}} value={query()} onInput={event => setQuery(event.currentTarget.value)} /></div></div><Suspense fallback={<span>Waiting for all sources</span>}><LibraryHome sdk={sdk} search={query()} onBrowse={(view, name) => setOpened(view+":"+name)} registerSync={() => {}} /></Suspense></>}>
        <CalendarGrid viewMode={mode()} onViewModeChange={setMode} anchor={anchor()} onAnchorChange={setAnchor} events={[{id:"event", itemId:"item", title:"Keyboard event", status:"active", time:new Date(2026,8,25,10).getTime(), triggerType:"at"}]} onEventClick={event => setOpened(event.title)} />
      </Show><output>{opened()}</output></>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><Router root={Fixture} /></DialogProvider></I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
        { find: "@ericsanchezok/synergy-ui/markdown", replacement: path.join(directory, "markdown.tsx") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@solidjs/router", "@lingui/core", "@lingui/solid", "zod"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === "/api/library/memory" && route.request().method() === "DELETE") {
      removedMemory = true
      return route.fulfill({ json: true })
    }
    if (pathname === "/api/library/experience/failed") {
      detailReads++
      return route.fulfill({
        status: detailFailure ? 503 : 200,
        json: detailFailure
          ? { message: "offline" }
          : { ...experience, script: "", raw: "Original source", metadata: "{}" },
      })
    }
    if (pathname === "/api/library/experience/page")
      return route.fulfill({ json: { items: [experience], total: 1, limit: 20, offset: 0, hasMore: false } })
    if (pathname === "/api/library/experience/search") return route.fulfill({ json: [experience] })
    if (pathname === "/api/library" || pathname === "/api/library/search") {
      await holdMemory
    }
    if (pathname === "/api/library" || pathname === "/api/library/search")
      return route.fulfill({
        status: memoryFailure ? 503 : 200,
        json: memoryFailure
          ? { message: "offline" }
          : [
              ...(removedMemory ? [] : [memory]),
              ...(multipleMemories ? [{ ...memory, id: "memory-second", title: "Second memory" }] : []),
            ],
      })
    if (pathname === "/api/skill")
      return route.fulfill({
        json: {
          items: [{ name: "frontend-check", description: "Check focus recovery" }],
          sources: [],
          diagnostics: [],
        },
      })
    return route.fulfill({ status: 404, json: { message: "unexpected fixture request" } })
  })
}, 60000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("feature-page typography follows its rendered role rather than legacy size aliases", async () => {
  await page.goto(`${url}?typography`)
  const style = (selector: string) =>
    page.locator(selector).evaluate((element) => {
      const value = getComputedStyle(element)
      return { size: value.fontSize, line: value.lineHeight, weight: value.fontWeight }
    })
  expect(await style("h1")).toEqual({ size: "20px", line: "24px", weight: "500" })
  expect(await style("header > span")).toEqual({ size: "12px", line: "16px", weight: "400" })
  expect(await style(".app-panel-body p")).toEqual({ size: "14px", line: "22px", weight: "400" })
})

test("ranking metric selection works with arrow keys and a single row needs no comparison animation", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`${url}?rank`)
  const calls = page.getByRole("radio", { name: "Calls", exact: true })
  await calls.focus()
  await page.keyboard.press("ArrowRight")
  expect(await page.getByRole("radio", { name: "Tokens", exact: true }).isChecked()).toBe(true)
  expect(await page.locator("article").textContent()).toContain("3 tokens")
  expect(await page.locator(".stats-rank-bar").count()).toBe(0)
  expect(await page.locator("article").evaluate((element) => getComputedStyle(element).animationName)).toBe("none")
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("experience dialog retries details and returns focus to the unchanged search result", async () => {
  errors.length = 0
  detailFailure = true
  memoryFailure = false
  detailReads = 0
  await page.goto(url)
  const entry = page.getByRole("button", { name: /Experience encoding failed/ }).first()
  await entry.press("Enter")
  await page.getByRole("dialog").waitFor()
  const detailAlert = page.getByRole("alert").filter({ hasText: "Unable to load details" })
  await detailAlert.waitFor()
  expect(await page.getByText("provider/model", { exact: true }).isVisible()).toBe(false)
  await page.getByRole("dialog").locator("summary").filter({ hasText: "Technical details" }).click()
  expect(await page.getByText("provider/model", { exact: true }).isVisible()).toBe(true)
  expect(await page.getByText("scope-source", { exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole("link", { name: "Open source session" }).getAttribute("href")).toBe(
    "/c2NvcGUtc291cmNl/session/session-source",
  )
  detailFailure = false
  await detailAlert.getByRole("button", { name: "Retry", exact: true }).click()
  await detailAlert.waitFor({ state: "detached" })
  expect(detailReads).toBe(2)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.classList.contains("library-home-result"))
  expect(await entry.evaluate((element) => element === document.activeElement)).toBe(true)
  expect(errors).toEqual([])
})

test("unified search isolates one failed category and its retry retains other results", async () => {
  memoryFailure = true
  await page.goto(url)
  await page.getByRole("textbox", { name: "Search library" }).fill("focus")
  await page.getByRole("button", { name: /frontend-check/ }).waitFor()
  const experienceEntry = page.getByRole("button", { name: /Experience encoding failed/ })
  await experienceEntry.waitFor()
  expect(await experienceEntry.count()).toBe(1)
  expect(await page.getByRole("alert").textContent()).toContain("Memories")
  memoryFailure = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  const memoryEntry = page.getByRole("button", { name: /Project testing/ }).first()
  await memoryEntry.press("Space")
  expect(await page.getByRole("dialog").isVisible()).toBe(true)
  expect(await page.getByText("Run focused behavior tests", { exact: true }).count()).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test("page tabs expose selection and support arrow and End navigation", async () => {
  await page.goto(url)
  const tabs = page.getByRole("tablist", { name: "Library views" })
  const home = tabs.getByRole("tab", { name: "Home", exact: true })
  expect((await page.locator(".app-panel-tabs").boundingBox())!.height).toBeLessThanOrEqual(40)
  await home.focus()
  await home.press("ArrowRight")
  expect(await tabs.getByRole("tab", { name: "Memories 100" }).getAttribute("aria-selected")).toBe("true")
  await page.keyboard.press("End")
  expect(await tabs.getByRole("tab", { name: "Statistics" }).getAttribute("aria-selected")).toBe("true")
  expect(await tabs.getByRole("tab").evaluateAll((elements) => elements.filter((el) => el.tabIndex === 0).length)).toBe(
    1,
  )
})

test("calendar events and month dates expose native keyboard actions", async () => {
  await page.goto(url)
  await page.getByRole("button", { name: "Toggle calendar" }).click()
  await page.getByRole("button", { name: /Keyboard event/ }).press("Enter")
  expect(await page.locator("output").textContent()).toBe("Keyboard event")
  await page.getByRole("radio", { name: "Month", exact: true }).press("Space")
  const dayEvents = page.locator(".agenda-month-day-list").getByRole("button", { name: /Keyboard event/ })
  await dayEvents.press("Space")
  await page.getByRole("button", { name: "Friday, September 25, 2026", exact: true }).press("Enter")
  expect(await dayEvents.count()).toBe(1)
  expect(errors).toEqual([])
})

test("a slow source does not suspend ready groups on the Library home", async () => {
  const release = Promise.withResolvers<void>()
  holdMemory = release.promise
  try {
    await page.goto(url)
    await page
      .getByRole("button", { name: /Experience encoding failed/ })
      .first()
      .waitFor({ timeout: 1200 })
    expect(await page.getByText("Waiting for all sources", { exact: true }).count()).toBe(0)
  } finally {
    holdMemory = undefined
    release.resolve()
  }
})

test("Library search remains inside a narrow header with all navigation reachable", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  try {
    await page.goto(url)
    const input = page.getByRole("textbox", { name: "Search library" })
    await input.waitFor()
    const bounds = await input.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
    await input.fill("focus")
    expect(await input.inputValue()).toBe("focus")
  } finally {
    await page.setViewportSize({ width: 1000, height: 800 })
  }
})

for (const category of ["Experience", "Memory"]) {
  test(`${category} selection checkbox activates its labeled card control`, async () => {
    await page.goto(`${url}?selection`)
    const section = page.getByRole("region", { name: `${category} selection` })
    const toggle = section.locator("button.library-card-toggle")
    await toggle.waitFor()
    const visual = section.locator(".size-4").first()
    await visual.click()
    expect(await toggle.getAttribute("aria-pressed")).toBe("true")
    await toggle.press("Space")
    expect(await toggle.getAttribute("aria-pressed")).toBe("false")
    await toggle.press("Enter")
    expect(await toggle.getAttribute("aria-pressed")).toBe("true")
  })
}

test("experience preview separates its first paragraph from the remaining context", async () => {
  await page.goto(`${url}?preview`)
  expect(await page.locator(".app-panel-row-title").first().textContent()).toBe("First useful paragraph")
  expect(await page.locator(".library-experience-summary").textContent()).toBe("Further context to read in the summary")
})

test("deleting a memory confirms separately and restores the neighboring item or search", async () => {
  multipleMemories = true
  removedMemory = false
  memoryFailure = false
  await page.goto(`${url}?remove`)
  await page.getByRole("button", { name: "Project testing", exact: true }).click()
  await page.getByRole("button", { name: "Delete memory", exact: true }).click()
  expect(await page.getByRole("button", { name: "Close Delete memory?", exact: true }).isVisible()).toBe(true)
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Second memory")
  multipleMemories = false
  removedMemory = false
  await page.goto(`${url}?remove`)
  await page.getByRole("button", { name: "Project testing", exact: true }).click()
  await page.getByRole("button", { name: "Delete memory", exact: true }).click()
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Search library")
  removedMemory = false
})

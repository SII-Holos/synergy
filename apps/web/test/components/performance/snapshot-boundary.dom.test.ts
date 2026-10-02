import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

setDefaultTimeout(60000)

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let baseUrl: string
const errors: string[] = []
const requests: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".snapshot-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { createSignal, onMount } from "solid-js"
    import { render } from "solid-js/web"
    import {DialogProvider, useDialog} from "@ericsanchezok/synergy-ui/context/dialog"
    import {createIntlFormatter} from "/@fs/${source}/context/locale/formatter.ts"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { SummaryCards, TraceDialog, TimeRangeControl, FrontendSection, IssueList, TopRankings } from ${JSON.stringify(`/@fs/${source}/components/performance/PerformanceDashboard.tsx`)}
    import { PerformanceSnapshotBoundary } from ${JSON.stringify(`/@fs/${source}/components/performance/snapshot-boundary.tsx`)}
    import { messages as en } from ${JSON.stringify(`/@fs/${source}/locales/en/messages.po`)}
    import { messages as zh } from ${JSON.stringify(`/@fs/${source}/locales/zh-CN/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}
    import ${JSON.stringify(`/@fs/${source}/components/performance/performance-panel.css`)}
    const query = new URLSearchParams(location.search)
    document.documentElement.dataset.colorScheme = query.get("theme") || "light"
    const i18n = setupI18n({ locale: query.get("locale") || "en", messages: { en, "zh-CN": zh } })
    const [state, setState] = createSignal({ loading: true, error: null, generatedAt: undefined })
    window.mounts = 0
    window.retries = 0
    window.fixture = {
      fail: () => setState(s => ({ ...s, loading: false, error: "diagnostic:" + "x".repeat(300) })),
      ready: () => setState({ loading: false, error: null, generatedAt: "2026-09-25T06:20:00.000Z" }),
    }
    function DetailFixture() {
      const dialog=useDialog()
      const [error,setError]=createSignal("Controlled trace failure")
      const [range,setRange]=createSignal(900000)
      return <><button type="button" onClick={()=>dialog.show(()=><TraceDialog _={i18n._.bind(i18n)} fmt={createIntlFormatter(()=>"en")} trace={{traceId:"trace-fixture",name:"GET /sessions",status:"ok",module:"server",durationMs:0,startedAt:"2026-10-01T00:00:00Z"}} detail={null} loading={false} error={error()} onRetry={()=>setError(undefined)}/>)}>Open trace</button><TimeRangeControl value={range()} onChange={setRange}/></>
    }
    function VitalsFixture() {
      return <FrontendSection _={i18n._.bind(i18n)} summary={{generatedAt:"2026-10-01T00:00:00Z",quality:{partial:true},top:{slowFrontend:[]},frontend:{cls:0,longTaskCount:0}}} />
    }
    function Results() { onMount(() => window.mounts++); return <div data-results>Healthy results</div> }
    render(() => <I18nProvider i18n={i18n}><DialogProvider>
      {query.has("rankings") ? <TopRankings _={i18n._.bind(i18n)} summary={{top:{slowRoutes:[{label:"http.request.duration",value:12,unit:"ms",traceId:"http-1"},{label:"GET /sessions",value:15,unit:"ms",traceId:"http-2"}]}}} onTrace={()=>{}}/> : query.has("trace") ? <DetailFixture/> : query.has("vitals") ? <VitalsFixture/> : query.has("issues") ? <IssueList _={i18n._.bind(i18n)} fmt={createIntlFormatter(()=>"en")} issues={[{issueId:"issue-1",code:"PERF_HTTP_SLOW_REQUEST",title:"Slow http.request",message:"Technical exception details",severity:"warning",lastSeenTime:1,occurrenceCount:2,module:"server",evidence:{},traceId:"trace-fixture"}]} onTrace={()=>{}}/> : query.has("summary") ? <div class="performance-workbench"><SummaryCards _={i18n._.bind(i18n)} summary={{health:{status:"healthy",openIssueCount:0},backend:{activeSessions:0,pendingSessions:0},resources:{owners:[],serviceMemory:{rssBytes:1048576,source:"process_api",completeness:"partial"},childProcessRssBytes:50,measuredChildProcessCount:5,childProcessCount:7},sessions:{llmCallCount:0,toolCallCount:0}}} /></div> : <PerformanceSnapshotBoundary loading={state().loading} error={state().error}
        generatedAt={state().generatedAt} attemptedAt={1} formatTime={() => "14:20:00"}
        onRetry={() => { window.retries++; setState(s => ({ ...s, loading: true, error: null })) }}>
        <Results />
      </PerformanceSnapshotBoundary>}
    </DialogProvider></I18nProvider>, document.querySelector("#root"))
  `,
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `
    import {useLingui} from "@lingui/solid"
    import {createIntlFormatter} from ${JSON.stringify(`/@fs/${source}/context/locale/formatter.ts`)}
    export const useLocale=()=>({i18n:useLingui().i18n(),fmt:createIntlFormatter(()=>"en")})
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: {
      alias: [
        {
          find: "lucide-solid",
          replacement: Bun.resolveSync("lucide-solid", path.resolve(source, "../../../packages/ui")),
        },
        { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "lucide-solid"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("requestfailed", (request) =>
    requests.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`),
  )
}, 120000)

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

interface FixtureWindow extends Window {
  mounts: number
  retries: number
  fixture: { fail(): void; ready(): void }
}

test.each(["light", "dark"])(
  "%s: failure gates results, supports keyboard retry and preserves stale content",
  async (theme) => {
    errors.length = 0
    await page.goto(`${baseUrl}?theme=${theme}`)
    await page.getByText("Loading performance snapshot…").waitFor()
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).mounts)).toBe(0)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fail())
    await page.getByRole("heading", { name: "Unable to fetch performance snapshot" }).waitFor()
    expect(await page.locator("[data-results]").count()).toBe(0)
    await page.locator("summary").focus()
    await page.keyboard.press("Enter")
    expect(await page.locator("details").getAttribute("open")).not.toBeNull()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole("button", { name: "Fetch again" }).focus()
    await page.keyboard.press("Enter")
    await page.getByText("Loading performance snapshot…").waitFor()
    expect(await page.getByRole("button").count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).retries)).toBe(1)
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.ready())
    await page.locator("[data-results]").waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fail())
    await page.getByRole("alert").waitFor()
    expect(await page.locator("[data-results]").isVisible()).toBe(true)
    expect(
      await page.getByText("Data as of 14:20:00. Current runtime health has not been confirmed.").isVisible(),
    ).toBe(true)
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).mounts)).toBe(1)
    expect(errors).toEqual([])
  },
)

test("the Chinese catalog localizes failure and stale recovery guidance", async () => {
  await page.goto(`${baseUrl}?locale=zh-CN`)
  await page.getByText("正在获取性能快照…").waitFor()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fail())
  await page.getByRole("button", { name: "重新获取" }).waitFor()
  expect(await page.getByRole("heading", { name: "无法获取性能快照" }).isVisible()).toBe(true)
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.ready())
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fail())
  await page.getByText("刷新失败，正在显示上次成功的快照。").waitFor()
  expect(await page.getByText("数据截至 14:20:00，当前运行状态尚未确认。").isVisible()).toBe(true)
})

test("summary prioritizes four signals and separates unavailable resource metrics from measured zero", async () => {
  await page.goto(`${baseUrl}?summary`)
  const resources = page.getByRole("region", { name: "Resource usage", exact: true })
  await resources.waitFor({ timeout: 5000 })
  expect(await page.locator(".performance-summary-grid > .performance-card").count()).toBe(4)
  expect(await resources.locator(".performance-card").filter({ hasText: "Long tasks" }).textContent()).toContain("—")
  expect(await resources.locator(".performance-card").filter({ hasText: "Disk ops" }).textContent()).toContain("—")
  expect(await resources.locator(".performance-card").filter({ hasText: "LLM calls" }).textContent()).toContain("0")
})

test("summary adapts to four, two and one columns while keeping session counts readable", async () => {
  await page.goto(`${baseUrl}?summary&locale=zh-CN`)
  await page.getByRole("region", { name: "资源使用情况", exact: true }).waitFor()
  for (const [width, columns] of [
    [1280, 4],
    [1020, 4],
    [768, 2],
    [375, 1],
  ]) {
    await page.setViewportSize({ width, height: 812 })
    const grid = page.locator(".performance-summary-grid")
    expect(await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(
      columns,
    )
    const sessions = grid.locator(".performance-card").filter({ hasText: "会话" }).locator(".performance-metric-value")
    expect(await sessions.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
})

test("session summary keeps each count adjacent to its label", async () => {
  await page.goto(`${baseUrl}?summary`)
  const card = page.locator(".performance-summary-grid > .performance-card").filter({ hasText: "Sessions" })
  expect(await card.locator(".performance-session-count").count()).toBe(2)
  expect(await card.locator(".performance-session-count").first().textContent()).toBe("0 active")
  expect(await card.locator(".performance-session-count").last().textContent()).toBe("0 pending")
})

test("trace details use the wide window, retry locally and return focus after Escape", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${baseUrl}?trace`)
  const trigger = page.getByRole("button", { name: "Open trace", exact: true })
  await trigger.click()
  const detail = page.getByRole("dialog")
  await detail.waitFor()
  expect(await detail.evaluate((el) => getComputedStyle(el).width)).toBe("720px")
  await detail.getByRole("button", { name: "Fetch again", exact: true }).click()
  expect(await detail.getByRole("alert").count()).toBe(0)
  await page.setViewportSize({ width: 375, height: 500 })
  expect(Math.round((await detail.boundingBox())!.width)).toBe(375)
  expect(Math.round((await detail.boundingBox())!.height)).toBe(500)
  await page.keyboard.press("Escape")
  await detail.waitFor({ state: "hidden" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Open trace")
})

test("time range is a keyboard radio group and browser vitals preserve zero and partial measurements", async () => {
  errors.length = 0
  await page.goto(`${baseUrl}?trace`)
  const range = page.getByRole("radio", { name: "15m", exact: true })
  await range.press("Space")
  await page.keyboard.press("ArrowRight")
  expect(await page.getByRole("radio", { name: "1h", exact: true }).isChecked()).toBe(true)
  await page.goto(`${baseUrl}?vitals`)
  await page
    .waitForFunction(() => document.querySelector("#root")?.childElementCount || false)
    .catch(async () => {
      throw new Error(
        JSON.stringify({
          errors,
          requests: requests.slice(-5),
          failedRequests: requests.length,
          body: await page.locator("body").innerText(),
        }),
      )
    })
  expect(errors).toEqual([])
  await page.getByText("CLS", { exact: true }).waitFor()
  const cls = page.locator(".performance-card-soft").filter({ has: page.getByText("CLS", { exact: true }) })
  expect(await cls.textContent()).toContain("0")
  expect(await cls.textContent()).toContain("Partial snapshot")
  expect(await page.getByText("No samples in this snapshot", { exact: true }).count()).toBeGreaterThan(0)
})

test("issues expose a translated category and severity before the original error", async () => {
  errors.length = 0
  await page.goto(`${baseUrl}?issues`)
  await page
    .waitForFunction(() => document.querySelector("#root")?.childElementCount || false)
    .catch(async () => {
      throw new Error(
        JSON.stringify({
          errors,
          requests: requests.slice(-5),
          failedRequests: requests.length,
          body: await page.locator("body").innerText(),
        }),
      )
    })
  expect(errors).toEqual([])
  await page.getByRole("heading", { name: "Slow HTTP request", exact: true }).waitFor()
  expect(await page.getByText("Warning", { exact: true }).isVisible()).toBe(true)
  expect(await page.getByText("Technical exception details", { exact: true }).isVisible()).toBe(false)
  await page.locator("summary").press("Enter")
  expect(await page.getByText("Technical exception details", { exact: true }).isVisible()).toBe(true)
  expect(await page.getByRole("button", { name: "Inspect related trace", exact: true }).isVisible()).toBe(true)
})

test("memory values keep their provenance and coverage in supporting text", async () => {
  await page.goto(`${baseUrl}?summary`)
  const memory = page.locator(".performance-resource-group .performance-card").filter({ hasText: "Service memory" })
  expect(await memory.locator(".performance-metric-value").innerText()).toBe("1 MiB")
  expect(await memory.locator("p.app-panel-caption").innerText()).toContain("process sum")
  expect(await memory.locator("p.app-panel-caption").innerText()).toContain("partial")
  const child = page.locator(".performance-resource-group .performance-card").filter({ hasText: "Tool child RSS" })
  expect(await child.locator(".performance-metric-value").innerText()).toBe("50 B")
  expect(await child.locator("p.app-panel-caption").innerText()).toContain("5/7")
})

test("request rankings distinguish unavailable route details from actual request names", async () => {
  await page.goto(`${baseUrl}?rankings`)
  const generic = page.getByRole("button", { name: /http.request.duration/ })
  await generic.waitFor()
  expect(await generic.innerText()).toContain("Information limited")
  expect(await page.getByRole("button", { name: /GET \/sessions/ }).innerText()).not.toContain("Information limited")
})

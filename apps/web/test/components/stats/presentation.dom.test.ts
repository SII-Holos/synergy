import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page, type Locator } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

setDefaultTimeout(60000)

let directory: string
let server: ViteDevServer
let browser: Browser
let page: Page
let url: string
const source = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".presentation-fixture-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `
    import { useLingui } from "@lingui/solid"
    import { createIntlFormatter } from "/@fs/${source}/context/locale/formatter.ts"
    export const useLocale = () => ({ i18n: useLingui().i18n(), fmt: createIntlFormatter(() => "zh-CN") })
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { MetaProvider } from "@solidjs/meta"
    import { Font } from "@ericsanchezok/synergy-ui/font"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
    import { OverviewCards } from "/@fs/${source}/components/stats/overview-cards.tsx"
    import { CodeSummary } from "/@fs/${source}/components/stats/code-summary.tsx"
    import { DailyTrend } from "/@fs/${source}/components/stats/daily-trend.tsx"
    import { ActivityHeatmap } from "/@fs/${source}/components/stats/hourly-heatmap.tsx"
    import { TokenRing } from "/@fs/${source}/components/stats/token-ring.tsx"
    import { messages } from "/@fs/${source}/locales/zh-CN/messages.po"
    import "@ericsanchezok/synergy-ui/styles"
    import "/@fs/${source}/index.css"
    import "/@fs/${source}/components/app-panel.css"
    import "/@fs/${source}/components/library/library-panel.css"
    import "/@fs/${source}/components/stats/stats.css"
    const query = new URLSearchParams(location.search)
    const i18n = setupI18n({ locale: "zh-CN", messages: { "zh-CN": messages } })
    const computedAt = new Date(2026, 9, 3, 12).getTime()
    const tokens = { input: 1800, output: 400, reasoning: 100, cache: { read: 7200, write: 200 } }
    const days = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(2026, 8, 20 + index)
      return { day: date.getFullYear()+"-"+String(date.getMonth()+1).padStart(2,"0")+"-"+String(date.getDate()).padStart(2,"0"), sessions: 2, turns: 6, tokens, cost: index === 13 ? 3.25 : 0.15, additions: 120, deletions: 30, files: 4, toolCalls: 8, errors: 0 }
    })
    const metrics = [
      { id: "sessions", label: "会话", value: "42", hint: "活跃 40 个 · 已归档 2 个" },
      { id: "turns", label: "轮次", value: "104", hint: "共 5.7K 条消息" },
      { id: "cost", label: "已知费用", value: "$15.59", hint: "$7.79/天" },
      { id: "tokens", label: "Token", value: "1.2M", hint: "提示缓存复用率 98%" },
      { id: "code", label: "新增行数", value: "120", hint: "净增 90" },
      { id: "projects", label: "项目", value: "3", hint: "2 个活跃日" },
    ]
    function Fixture() {
      useTheme().setColorScheme(query.get("theme") || "light")
      return <main class="app-panel synergy-workbench-canvas library-workbench" style={{ padding: "24px", width: "min(960px, 100%)", margin: "0 auto" }}>
        <div class="library-stats-content stats-content flex flex-col gap-5">
          <section data-case="overview"><OverviewCards metrics={metrics} streak={{ current: 2, longest: 4 }}/></section>
          <section data-case="trend"><DailyTrend days={days} computedAt={computedAt}/></section>
          <section data-case="activity"><ActivityHeatmap days={days} computedAt={computedAt} hours={[{ hour: "2026-10-03T10", turns: 6 }]}/></section>
          <section data-case="tokens"><TokenRing tokens={tokens} cacheHitRate={0.8}/></section>
          <section data-case="code"><CodeSummary codeChanges={{ totalAdditions: 120, totalDeletions: 30, netLines: 90, totalFiles: 4, dailyAdditions: 60, dailyDeletions: 15 }}/></section>
        </div>
      </main>
    }
    render(() => <MetaProvider><Font/><I18nProvider i18n={i18n}><ThemeProvider><Fixture/></ThemeProvider></I18nProvider></MetaProvider>, document.getElementById("root"))
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
        {
          find: "lucide-solid",
          replacement: Bun.resolveSync("lucide-solid", path.resolve(source, "../../../packages/ui")),
        },
        { find: "@", replacement: source },
      ],
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "chart.js", "lucide-solid"],
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 120000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function framingLayers(target: Locator, excludeTarget = false) {
  return target.evaluate((element, skip) => {
    let current = skip ? element.parentElement : element
    let layers = 0
    while (current && !current.hasAttribute("data-case")) {
      const style = getComputedStyle(current)
      const fill = style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent"
      const border = [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ].every((value) => parseFloat(value) > 0)
      if (fill || border || style.boxShadow !== "none") layers++
      current = current.parentElement
    }
    return layers
  }, excludeTarget)
}

test.each(["light", "dark"])("%s: overview, trends and code use one content surface at most", async (theme) => {
  await page.goto(`${url}?theme=${theme}`)
  await page.locator('[data-case="trend"] canvas').waitFor()
  await page.evaluate(() => document.fonts.ready)
  expect(errors).toEqual([])
  expect(
    await framingLayers(page.locator('[data-case="overview"]').getByText("会话", { exact: true })),
  ).toBeLessThanOrEqual(1)
  expect(await framingLayers(page.locator('[data-case="trend"] canvas'))).toBe(0)
  expect(await framingLayers(page.getByText("最高成本", { exact: true }))).toBe(0)
  expect(await framingLayers(page.locator('[data-case="code"]').getByText("净代码增长", { exact: true }))).toBe(0)
  expect(await framingLayers(page.locator('[data-case="code"]').getByText("新增行数", { exact: true }))).toBe(0)
  expect(await page.locator('[data-case="code"]').getByText("+90", { exact: true }).count()).toBe(1)
  expect(
    await page
      .locator('[data-case="code"]')
      .getByText(/150.*行/)
      .isVisible(),
  ).toBe(true)
  expect(await framingLayers(page.locator('[data-case="activity"] [title]').first(), true)).toBe(0)
  expect(await framingLayers(page.locator('[data-case="tokens"] canvas'))).toBe(0)
  const output = process.env.SYNERGY_SURFACE_SCREENSHOTS
  if (output) {
    await mkdir(output, { recursive: true })
    for (const section of ["overview", "trend", "activity", "code"]) {
      await page
        .locator(`[data-case="${section}"]`)
        .screenshot({ path: path.join(output, `usage-${section}-${theme}.png`) })
    }
  }
})

test("usage layouts adapt to their available width without losing data or range controls", async () => {
  await page.goto(url)
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    expect(await page.locator('[data-case="overview"]').getByText("$15.59", { exact: true }).isVisible()).toBe(true)
    expect(await page.locator('[data-case="code"]').getByText("+120", { exact: true }).isVisible()).toBe(true)
    const output = process.env.SYNERGY_SURFACE_SCREENSHOTS
    if (output) {
      await mkdir(output, { recursive: true })
      await page.screenshot({ path: path.join(output, `usage-light-${width}.png`), fullPage: true })
    }
  }
  const range = page.locator('[data-case="trend"]').getByRole("button", { name: "7 天", exact: true })
  await range.focus()
  await range.press("Enter")
  expect(await range.getAttribute("aria-pressed")).toBe("true")
  await page.locator('[data-case="activity"]').getByRole("button", { name: "30 天", exact: true }).click()
  expect(await page.locator('[data-case="activity"] [title]').count()).toBe(30)
})

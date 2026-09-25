import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let baseUrl: string
const errors: string[] = []
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
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
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
    function Results() { onMount(() => window.mounts++); return <div data-results>Healthy results</div> }
    render(() => <I18nProvider i18n={i18n}>
      <PerformanceSnapshotBoundary loading={state().loading} error={state().error}
        generatedAt={state().generatedAt} attemptedAt={1} formatTime={() => "14:20:00"}
        onRetry={() => { window.retries++; setState(s => ({ ...s, loading: true, error: null })) }}>
        <Results />
      </PerformanceSnapshotBoundary>
    </I18nProvider>, document.querySelector("#root"))
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin(), tailwindcss(), ...lingui()],
    resolve: { alias: { "@": source } },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.on("pageerror", (error) => errors.push(error.message))
})

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

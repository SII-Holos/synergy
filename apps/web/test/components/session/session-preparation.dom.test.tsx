import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let baseUrl: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".preparation-fixture-"))
  const context = path.join(directory, "context.tsx")
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      context,
      `
      import { createSignal } from "solid-js"
      import { setupI18n } from "@lingui/core"
      import { createReactiveI18n } from ${JSON.stringify(`/@fs/${source}/context/locale/reactive-i18n.ts`)}
      const mode = new URLSearchParams(location.search).get("mode")
      const [id, setID] = createSignal("history")
      const [url, setURL] = createSignal("one")
      const [generation, setGeneration] = createSignal(0)
      export const core = setupI18n({ locale: "en", messages: { en: {}, "zh-CN": {
        "app.upgrade.sessionPreparing": "正在准备此会话",
        "app.upgrade.sessionFiles": "已准备 {count} 个文件",
        "app.upgrade.leave": "返回工作区",
      } } })
      const i18n = createReactiveI18n(core, generation)
      let ready = false
      let late: (() => void) | undefined
      const requests: Array<{ action: string; sessionID: string; signal: AbortSignal }> = []
      const value = (sessionID: string, state: string) => ({ sessionID, state, files: 7, bytes: 100 })
      async function request(action, input, options) {
        requests.push({ action, sessionID: input.sessionID, signal: options.signal })
        if (input.sessionID === "fresh" || url() === "two") return { data: value(input.sessionID, "ready") }
        if (mode === "slow") return new Promise(resolve => { late = () => resolve({ data: value(input.sessionID, "blocked") }) })
        if (mode === "failed" && action === "prepare") throw new Error("Storage temporarily unavailable")
        return { data: value(input.sessionID, mode === "blocked" ? "blocked" : action === "retry" || ready ? "ready" : "preparing") }
      }
      export const useParams = () => ({ get id() { return id() } })
      export const useNavigate = () => () => setID("")
      export const useServer = () => ({ get url() { return url() } })
      export const useLocale = () => ({ i18n })
      export const useGlobalSDK = () => ({ client: { storage: {
        prepareSession: (input, options) => request("prepare", input, options),
        upgradeSession: (input, options) => request("poll", input, options),
        retrySession: (input, options) => request("retry", input, options),
      } } })
      export const fixture = {
        id,
        complete: () => { ready = true },
        locale: () => { core.activate("zh-CN"); setGeneration(n => n + 1) },
        navigate: () => setID("fresh"),
        switchServer: () => setURL("two"),
        late: () => late?.(),
        requests: () => requests.map(({ action, sessionID, signal }) => ({ action, sessionID, aborted: signal.aborted })),
      }
      window.fixture = fixture
    `,
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
      import { onMount } from "solid-js"
      import { render } from "solid-js/web"
      import { I18nProvider } from "@lingui/solid"
      import { SessionPreparation } from ${JSON.stringify(`/@fs/${source}/components/session/session-preparation.tsx`)}
      import { core, fixture } from "./context"
      window.mounts = 0
      function Transcript() {
        onMount(() => window.mounts++)
        return <div data-transcript>{fixture.id() || "workspace"}</div>
      }
      render(() => <I18nProvider i18n={core}><SessionPreparation><Transcript /></SessionPreparation></I18nProvider>, document.querySelector("#root")!)
    `,
    ),
  ])
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, "vite-cache"),
    plugins: [solidPlugin()],
    resolve: {
      alias: {
        "@/context/global-sdk": context,
        "@/context/server": context,
        "@/context/locale": context,
        "@solidjs/router": context,
        "@": source,
      },
    },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"],
    },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(source, "../../..")] } },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

interface FixtureWindow extends Window {
  mounts: number
  fixture: {
    complete(): void
    locale(): void
    navigate(): void
    switchServer(): void
    late(): void
    requests(): Array<{ action: string; sessionID: string; aborted: boolean }>
  }
}

async function open(mode = "pending") {
  errors.length = 0
  await page.goto(`${baseUrl}?mode=${mode}`)
  await page
    .getByRole("status")
    .waitFor({ timeout: 10000 })
    .catch((error) => {
      throw new Error(`${error.message}\n${errors.join("\n")}`)
    })
  expect(await page.locator("[data-transcript]").count()).toBe(0)
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).mounts)).toBe(0)
}

test("preparation gates transcript mounting, updates localized progress and admits only ready history", async () => {
  await open()
  await page.getByText("7 files prepared").waitFor()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.locale())
  await page.getByText("已准备 7 个文件").waitFor()
  expect(await page.getByRole("button", { name: "返回工作区" }).count()).toBe(1)
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.complete())
  await page.locator("[data-transcript]").waitFor()
  expect(await page.locator("[data-transcript]").textContent()).toBe("history")
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).mounts)).toBe(1)
  expect(errors).toEqual([])
})

test("retryable failures offer a real retry while quarantined history only offers a safe exit", async () => {
  await open("failed")
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.locator("[data-transcript]").waitFor()
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.requests())).toEqual([
    { action: "prepare", sessionID: "history", aborted: true },
    { action: "retry", sessionID: "history", aborted: false },
  ])
  await open("blocked")
  await page.getByText(/Your original data and recovery files are preserved/).waitFor()
  expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0)
  await page.getByRole("button", { name: "Back to workspace" }).click()
  expect(await page.locator("[data-transcript]").textContent()).toBe("workspace")
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.requests())).toEqual([
    { action: "prepare", sessionID: "history", aborted: true },
  ])
  expect(errors).toEqual([])
})

test.each(["navigate", "switchServer"] as const)(
  "%s aborts obsolete preparation and ignores its late quarantine result",
  async (action) => {
    await open("slow")
    await page.evaluate((action) => (window as unknown as FixtureWindow).fixture[action](), action)
    await page.locator("[data-transcript]").waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.late())
    const expected = action === "navigate" ? "fresh" : "history"
    expect(await page.locator("[data-transcript]").textContent()).toBe(expected)
    expect(await page.getByRole("status").count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.requests())).toEqual([
      { action: "prepare", sessionID: "history", aborted: true },
      { action: "prepare", sessionID: expected, aborted: false },
    ])
    expect(errors).toEqual([])
  },
)

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser
let page: Page
let server: BrowserFixture
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
      '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      context,
      `
      import { createSignal } from "solid-js"
      import { createSessionPreparationCache } from ${JSON.stringify(`${source}/context/session-preparation-cache.ts`)}
      import { setupI18n } from "@lingui/core"
      import { createReactiveI18n } from ${JSON.stringify(`${source}/context/locale/reactive-i18n.ts`)}
      const mode = new URLSearchParams(location.search).get("mode")
      const [id, setID] = createSignal(mode === "new" ? "" : "history")
      const [url, setURL] = createSignal("one")
      const [generation, setGeneration] = createSignal(0)
      export const core = setupI18n({ locale: "en", messages: { en: {}, "zh-CN": {
        "app.upgrade.sessionPreparing": "正在准备此会话",
        "app.upgrade.sessionFiles": "已准备 {count} 个文件",
        "app.upgrade.leave": "返回工作区",
      } } })
      const i18n = createReactiveI18n(core, generation)
      const sessionPreparation = createSessionPreparationCache()
      let ready = false
      let late: (() => void) | undefined
      const requests: Array<{ action: string; sessionID: string; signal: AbortSignal }> = []
      const value = (sessionID: string, state: string) => ({ sessionID, state, files: 7, bytes: 100 })
      async function request(action, input, options) {
        requests.push({ action, sessionID: input.sessionID, signal: options.signal })
        if (mode === "warm" || input.sessionID === "fresh" || url() === "two") return { data: value(input.sessionID, "ready") }
        if (mode === "slow") return new Promise(resolve => { late = () => resolve({ data: value(input.sessionID, "blocked") }) })
        if (mode === "failed" && action === "prepare") throw new Error("Storage temporarily unavailable")
        return { data: value(input.sessionID, mode === "blocked" ? "blocked" : action === "retry" || ready ? "ready" : "preparing") }
      }
      export const useParams = () => ({ get id() { return id() } })
      export const useNavigate = () => () => setID("")
      export const useServer = () => ({ get url() { return url() } })
      export const useLocale = () => ({ i18n })
      export const useGlobalSDK = () => ({ sessionPreparation, client: { storage: {
        prepareSession: (input, options) => request("prepare", input, options),
        upgradeSession: (input, options) => request("poll", input, options),
        retrySession: (input, options) => request("retry", input, options),
      } } })
      export const fixture = {
        id,
        complete: () => { ready = true },
        locale: () => { core.activate("zh-CN"); setGeneration(n => n + 1) },
        navigate: () => setID("fresh"),
        navigateTo: (id: string) => setID(id),
        submit: () => setID("created"),
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
      import { createEffect, createSignal, Show, onMount } from "solid-js"
      import { render } from "solid-js/web"
      import { I18nProvider } from "@lingui/solid"
      import { MetaProvider } from "@solidjs/meta"
      import { Font } from "@ericsanchezok/synergy-ui/font"
      import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
      import { Button } from "@ericsanchezok/synergy-ui/button"
      import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
      import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
      import { SessionPreparation, SessionPreparationNotice, useSessionPreparation } from ${JSON.stringify(`${source}/components/session/session-preparation.tsx`)}
      import { SessionTransitionProvider } from ${JSON.stringify(`${source}/context/session-transition.tsx`)}
      import "@ericsanchezok/synergy-ui/styles"
      import "@/index.css"
      import "@/components/settings/settings-panel.css"
      import "@/components/settings/settings-controls.css"
      import { core, fixture } from "./context"
      window.mounts = 0
      function Transcript() {
        onMount(() => window.mounts++)
        const preparation = useSessionPreparation()
        const [seen,setSeen] = createSignal(!fixture.id())
        createEffect(() => { if(preparation.ready()) setSeen(true) })
        return <div class="synergy-workbench-canvas" style="height:100dvh;display:flex;flex-direction:column"><header>Session shell</header><input aria-label="composer" /><nav>Workspace navigation</nav><main style="flex:1;min-height:0"><Show when={seen()} fallback={<SessionPreparationNotice />}><div data-transcript data-ready={preparation.ready()}>{fixture.id() || "workspace"}</div></Show></main><div class="settings-control-scope"><Button data-settings-reference>Settings control</Button></div></div>
      }
      function Fixture() {
        fixture.theme = useTheme().setColorScheme
        return <SessionPreparation><Transcript /></SessionPreparation>
      }
      render(() => <MetaProvider><Font /><ThemeProvider><I18nProvider i18n={core}><SessionTransitionProvider><DialogProvider><MarkedProvider><Fixture /></MarkedProvider></DialogProvider></SessionTransitionProvider></I18nProvider></ThemeProvider></MetaProvider>, document.querySelector("#root")!)
    `,
    ),
  ])
  server = await createBrowserFixture({
    root: directory,
    styled: true,
    aliases: [
      ...[
        "@/context/global-sdk",
        "@/context/server",
        "@/context/locale",
        "@solidjs/router",
        "@/context/session-route",
      ].map((find) => ({ find, replacement: context })),
      { find: "@", replacement: source },
    ],
  })
  baseUrl = server.url
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
}, 180_000)

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
}, 60_000)

interface FixtureWindow extends Window {
  mounts: number
  fixture: {
    theme(value: "light" | "dark"): void
    complete(): void
    locale(): void
    navigate(): void
    navigateTo(id: string): void
    submit(): void
    switchServer(): void
    late(): void
    requests(): Array<{ action: string; sessionID: string; aborted: boolean }>
  }
}

test.each(["light", "dark"] as const)(
  "%s preparation actions share Settings surfaces and retain keyboard navigation",
  async (theme) => {
    await open()
    await page.evaluate((theme) => (window as unknown as FixtureWindow).fixture.theme(theme), theme)
    await page.waitForFunction((theme) => document.documentElement.dataset.colorScheme === theme, theme)
    await page.evaluate(() => document.fonts.ready)
    const back = page.getByRole("button", { name: "Back to workspace" })
    const reference = page.locator("[data-settings-reference]")
    await back.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
    await reference.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
    const appearance = (element: HTMLElement) => {
      const style = getComputedStyle(element)
      return {
        background: style.backgroundColor,
        color: style.color,
        border: style.borderWidth,
        shadow: style.boxShadow,
      }
    }
    expect(await back.evaluate(appearance)).toEqual(await reference.evaluate(appearance))
    expect(await back.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32)
    expect(await back.evaluate((element) => parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThanOrEqual(
      8,
    )
    await back.hover()
    await back.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
    const hovered = await back.evaluate(appearance)
    await reference.hover()
    await reference.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
    expect(hovered).toEqual(await reference.evaluate(appearance))
    await page.mouse.move(0, 0)
    await page.getByRole("textbox", { name: "composer" }).focus()
    await page.keyboard.press("Tab")
    expect(
      await back.evaluate((element) => element === document.activeElement && element.matches(":focus-visible")),
    ).toBe(true)
    expect(await back.evaluate((element) => getComputedStyle(element).backgroundImage)).not.toBe("none")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
    await page.keyboard.press("Enter")
    await page.locator("[data-transcript]").waitFor()
    expect(await page.locator("[data-transcript]").textContent()).toBe("workspace")
    expect(errors).toEqual([])
  },
)

test("first-send navigation preserves the mounted page while its storage preparation is pending", async () => {
  await page.goto(`${baseUrl}?mode=new`)
  await page.locator("[data-transcript]").waitFor()
  await page.evaluate(() => {
    ;(window as unknown as Window & { pageNode: Element | null }).pageNode = document.querySelector("[data-transcript]")
    ;(window as unknown as FixtureWindow).fixture.submit()
  })
  await page.waitForFunction(() => (window as unknown as FixtureWindow).fixture.requests().length === 1)
  expect(await page.locator("[data-transcript]").count()).toBe(1)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Window & { pageNode: Element }).pageNode === document.querySelector("[data-transcript]"),
    ),
  ).toBe(true)
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).mounts)).toBe(1)
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.complete())
  await page.getByRole("status").waitFor({ state: "detached" })
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).mounts)).toBe(1)
})

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
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).mounts)).toBe(1)
  expect(await page.getByRole("textbox", { name: "composer" }).isEnabled()).toBe(true)
  expect(await page.getByText("Workspace navigation").isVisible()).toBe(true)
}

test("preparation keeps the shell usable, updates local progress and admits only ready history", async () => {
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

test("returning to a prepared session keeps cached content admitted without another storage request", async () => {
  await page.goto(`${baseUrl}?mode=warm`)
  await page.locator('[data-transcript][data-ready="true"]').waitFor()
  await page.evaluate(() => (window as unknown as FixtureWindow).fixture.navigate())
  await page.waitForFunction(
    () =>
      document.querySelector("[data-transcript]")?.textContent === "fresh" &&
      document.querySelector("[data-transcript]")?.getAttribute("data-ready") === "true",
  )
  const admitted = await page.evaluate(() => {
    ;(window as unknown as FixtureWindow).fixture.navigateTo("history")
    return {
      ready: document.querySelector("[data-transcript]")?.getAttribute("data-ready"),
      requests: (window as unknown as FixtureWindow).fixture.requests().length,
    }
  })
  expect(admitted).toEqual({ ready: "true", requests: 2 })
  expect(errors).toEqual([])
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"

let browser: Browser
let server: ViteDevServer
let directory: string
let url: string
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".space-switcher-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal } from "solid-js"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { SpaceSwitcher } from ${JSON.stringify(`/@fs/${source}/components/sidebar/space-switcher.tsx`)}
    const i18n = setupI18n({ locale: "en", messages: { en: {}, "zh-CN": {
      "app.sidebar.space.current": "当前空间", "app.sidebar.space.personal": "个人空间",
      "app.sidebar.menu.settings": "设置", "app.sidebar.menu.providers": "模型提供方", "app.sidebar.menu.repository": "仓库"
    } } })
    const [expanded, setExpanded] = createSignal(true)
    window.fixture = { setExpanded, locale: value => i18n.activate(value), actions: [] }
    render(() => <I18nProvider i18n={i18n}><div style="width:260px;margin-top:200px">
      <SpaceSwitcher expanded={expanded()} onSettings={value => window.fixture.actions.push(value)} onRepository={() => window.fixture.actions.push("repository")} />
    </div></I18nProvider>, document.getElementById("root"))
  `,
  )
  server = await createServer({
    root: directory,
    configFile: false,
    plugins: [solid()],
    resolve: { alias: { "@": source }, conditions: ["browser", "development"] },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(source, "../../..")] },
    },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]
  browser = await chromium.launch({ headless: true })
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("personal space exposes exactly three working actions and restores keyboard focus", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 680 } })
  try {
    page.setDefaultTimeout(10_000)
    await page.goto(url)
    const trigger = page.getByRole("button", { name: "Current space" })
    await trigger.waitFor()
    expect(await trigger.innerText()).toContain("Personal space")
    await trigger.focus()
    await page.keyboard.press("Enter")
    await page.getByRole("menu").waitFor()
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Settings", "Providers", "Repository"])
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.matches(".space-switcher-trigger"))
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
    for (const name of ["Settings", "Providers", "Repository"]) {
      await trigger.click()
      await page.getByRole("menuitem", { name, exact: true }).click()
    }
    await page.waitForFunction(
      () => (window as unknown as { fixture: { actions: string[] } }).fixture.actions.length === 3,
    )
    expect(
      await page.evaluate(() => (window as unknown as { fixture: { actions: string[] } }).fixture.actions),
    ).toEqual(["general", "providers", "repository"])
  } finally {
    await page.close()
  }
}, 30_000)

test("collapsed space retains its accessible name and follows live locale changes", async () => {
  const page = await browser.newPage()
  try {
    page.setDefaultTimeout(10_000)
    await page.goto(url)
    await page.getByRole("button", { name: "Current space" }).waitFor()
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { fixture: { setExpanded(value: boolean): void; locale(value: string): void } }
      ).fixture
      fixture.setExpanded(false)
      fixture.locale("zh-CN")
    })
    const trigger = page.getByRole("button", { name: "当前空间" })
    await trigger.waitFor()
    expect(await trigger.locator("img").count()).toBe(1)
    await trigger.click()
    expect(await page.getByRole("menuitem").count()).toBe(3)
    await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]'))
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.matches(".space-switcher-trigger"))
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
  } finally {
    await page.close()
  }
}, 30_000)

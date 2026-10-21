import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let directory: string, server: BrowserFixture, browser: Browser, page: Page
const errors: string[] = []
const app = path.resolve(import.meta.dir, "../../..")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".plan-blueprint-offer-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    'import { useLingui } from "@lingui/solid"; export const useLocale = () => ({ i18n: useLingui().i18n() })',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { MetaProvider } from "@solidjs/meta"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { Font } from "@ericsanchezok/synergy-ui/font"
    import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
    import { PlanBlueprintOfferControl } from ${JSON.stringify(path.join(app, "src/components/prompt-input/plan-blueprint-offer.tsx"))}
    import { messages as en } from ${JSON.stringify(path.join(app, "src/locales/en/messages.po"))}
    import { messages as zh } from ${JSON.stringify(path.join(app, "src/locales/zh-CN/messages.po"))}
    import { messages as pseudo } from ${JSON.stringify(path.join(app, "src/locales/pseudo/messages.po"))}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(path.join(app, "src/index.css"))}
    const params = new URLSearchParams(location.search)
    const locale = params.get("locale") || "en"
    window.fixture = { equipped: 0, muted: 0, dismissed: 0, release() {} }
    function Fixture() {
      useTheme().setColorScheme(params.get("theme") || "light")
      return <div class="synergy-workbench-canvas" style="padding:24px;min-height:100dvh">
        <div id="offer-pane" style="width:375px;padding-top:120px;display:flex;justify-content:center">
          <PlanBlueprintOfferControl offer={{title:"Blueprint: Zero-Configuration Personalized Workspace and responsive controls"}}
            onEquip={() => { window.fixture.equipped++; return new Promise(resolve => window.fixture.release = resolve) }}
            onMute={() => window.fixture.muted++} onDismiss={() => window.fixture.dismissed++}/>
        </div>
      </div>
    }
    render(() => <MetaProvider><Font/><I18nProvider i18n={setupI18n({locale,messages:{en,"zh-CN":zh,pseudo}})}><ThemeProvider><Fixture/></ThemeProvider></I18nProvider></MetaProvider>, document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({
    root: directory,
    styled: true,
    aliases: [
      { find: "@/context/locale", replacement: path.join(directory, "locale.ts") },
      { find: "@", replacement: path.join(app, "src") },
    ],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 650 }, reducedMotion: "reduce" })
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

for (const locale of ["en", "zh-CN", "pseudo"])
  test(`${locale} offer actions collapse with their pane without wrapping or losing their names`, async () => {
    for (const theme of ["light", "dark"]) {
      await page.goto(`${server.url}?locale=${locale}&theme=${theme}`)
      const offer = page.getByRole("status")
      await offer.waitFor()
      await page.evaluate(() => document.fonts.ready)
      const labels = offer.locator("button > .text-12-medium")
      const heights: number[] = []
      for (const width of [280, 320, 375, 460, 480, 481, 620, 375]) {
        await page.locator("#offer-pane").evaluate((node, width) => (node.style.width = `${width}px`), width)
        expect(await labels.count()).toBe(2)
        for (const label of await labels.all()) expect(await label.isVisible()).toBe(width > 480)
        const bounds = await offer.boundingBox()
        const pane = await page.locator("#offer-pane").boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(pane!.x)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(pane!.x + pane!.width + 1)
        heights.push(bounds!.height)
        for (const button of await offer.getByRole("button").all()) {
          expect(await button.getAttribute("aria-label")).toBeTruthy()
          const box = await button.boundingBox()
          expect(box!.x).toBeGreaterThanOrEqual(bounds!.x)
          expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
          expect(box!.width).toBeGreaterThanOrEqual(24)
        }
      }
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
    }
    expect(errors).toEqual([])
  })

test("compact offer actions retain tooltips, keyboard activation and their pending hit area", async () => {
  await page.goto(`${server.url}?locale=zh-CN`)
  const equip = page.getByRole("button", { name: "启用 Blueprint", exact: true })
  await equip.focus()
  await page.getByRole("tooltip").waitFor({ state: "visible" })
  expect(await page.getByRole("tooltip").innerText()).toContain("在当前任务中启用此 Blueprint")
  const bounds = await equip.boundingBox()
  await page.keyboard.press("Enter")
  expect(await equip.isDisabled()).toBe(true)
  expect(await equip.boundingBox()).toEqual(bounds)
  await page.evaluate(() => (window as unknown as { fixture: { release(): void } }).fixture.release())
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".plan-blueprint-offer-action")?.disabled)
  await page.keyboard.press("Tab")
  expect(
    await page
      .getByRole("button", { name: "不再询问", exact: true })
      .evaluate((node) => node === document.activeElement),
  ).toBe(true)
  await page.keyboard.press("Space")
  await page.keyboard.press("Tab")
  expect(
    await page
      .getByRole("button", { name: "关闭 Blueprint 推荐", exact: true })
      .evaluate((node) => node === document.activeElement),
  ).toBe(true)
  await page.keyboard.press("Enter")
  expect(
    await page.evaluate(() => {
      const { equipped, muted, dismissed } = (
        window as unknown as { fixture: { equipped: number; muted: number; dismissed: number } }
      ).fixture
      return { equipped, muted, dismissed }
    }),
  ).toEqual({ equipped: 1, muted: 1, dismissed: 1 })
  expect(errors).toEqual([])
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../../support/browser-fixture"

let browser: Browser
let server: BrowserFixture
let directory: string
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".resource-admission-"))
  const app = path.resolve(import.meta.dir, "../../../../src")
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { MetaProvider } from "@solidjs/meta"
    import { createSignal } from "solid-js"
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { Font } from "@ericsanchezok/synergy-ui/font"
    import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
    import { TimeoutsPanel } from "/@fs/${app}/components/settings/panels/RuntimePanels.tsx"
    import { defaultSettingsState } from "/@fs/${app}/components/settings/types.ts"
    import "@ericsanchezok/synergy-ui/styles"
    import "/@fs/${app}/index.css"
    import "/@fs/${app}/components/settings/settings-panel.css"
    const i18n = setupI18n({ locale: "en", messages: { en: {} } })
    const [reason, setReason] = createSignal("available")
    window.setResourceReason = setReason
    render(() => <MetaProvider><I18nProvider i18n={i18n}><ThemeProvider><Font /><div class="settings-panel-frame"><TimeoutsPanel
      runtime={defaultSettingsState("enter").runtime} onRuntimeChange={() => {}}
      availableAgents={[]} fileToolGroup="replace" onFileToolGroupChange={() => {}}
      defaultAgent="" onDefaultAgentChange={() => {}}
      resourceStatus={{ revision: 1, reason: reason(), state: "normal", snapshot: null, active: 2, queued: 3, headroomBytes: 512 * 1024 ** 2, reserveBytes: 0, reservedBytes: 0, nextReviewAt: 0 }}
      capacityStatus={{ configured: 12, ceiling: 12, source: "explicit", workers: 2, active: 2, queued: 3 }}
      concurrencyStatus={{ configured: 32, environment: null, effective: 32, source: "config", running: 2, queued: 3 }}
    /></div></ThemeProvider></I18nProvider></MetaProvider>, document.getElementById("root"))
  `,
  )
  server = await createBrowserFixture({ root: directory, styled: true, aliases: [{ find: "@", replacement: app }] })
  browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("renders live admission reasons and preserves the configured ceiling at narrow widths", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(server.url)
    await page.getByText("Resource admission", { exact: true }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    expect(await page.getByText("Configured: 12", { exact: true }).isVisible()).toBe(true)
    for (const [reason, text] of [
      ["critical_pressure", "New work paused until memory pressure eases"],
      ["execution_capacity", "Waiting for an execution slot"],
      ["recovering", "Resuming gradually as memory recovers"],
      ["available", "Ready for new work"],
    ]) {
      await page.evaluate(
        (value) => (window as unknown as { setResourceReason(value: string): void }).setResourceReason(value),
        reason!,
      )
      await page.getByText(text!, { exact: true }).waitFor()
    }
    expect(await page.locator("body").innerText()).toContain("2 active stages · 3 waiting · 512 MiB")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
    if (process.env.SYNERGY_RESOURCE_SCREENSHOT)
      await page.screenshot({ path: process.env.SYNERGY_RESOURCE_SCREENSHOT, fullPage: true })
  } finally {
    await page.close()
  }
}, 30_000)

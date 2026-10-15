import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let directory: string, server: BrowserFixture, browser: Browser, page: Page
const errors: string[] = []
const app = path.resolve(import.meta.dir, "../../..")
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".loop-status-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "locale.ts"),
    `
    import { setupI18n } from "@lingui/core"
    export const i18n = setupI18n({ locale: "en", messages: {} })
    export const useLocale = () => ({ i18n })
  `,
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { createSignal } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
    import { LoopStatusEntry, LoopStatusDialog } from ${JSON.stringify(path.join(app, "src/components/prompt-input/loop-status-entry.tsx"))}
    import { i18n } from "./locale"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(path.join(app, "src/index.css"))}
    const [value, setValue] = createSignal({ kind:"blueprint", stage:"bound", title:"A long task title ".repeat(30), reason:"Missing cancellation coverage", terminal:false })
    window.fixture = { set(stage,kind="blueprint") { setValue({ ...value(), kind, stage, terminal:["completed","failed","cancelled","timed_out","iteration_exhausted"].includes(stage) }) }, pauses:0 }
    function App() {
      const dialog = useDialog()
      return <div class="prompt-input" style={{width:"100%", "container-type":"inline-size", "container-name":"prompt-input"}} onKeyDown={event => { if(event.key==="Escape") window.fixture.pauses++ }}>
        <LoopStatusEntry value={value()} onOpen={() => dialog.show(() => <LoopStatusDialog value={value} />)} />
        <textarea aria-label="Message" />
      </div>
    }
    render(() => <I18nProvider i18n={i18n}><DialogProvider><App/></DialogProvider></I18nProvider>, document.getElementById("root"))
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
  page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
}, 60000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

for (const width of [320, 375, 720])
  test(`every Loop stage stays labeled and stable in a ${width}px pane`, async () => {
    await page.setViewportSize({ width, height: 700 })
    await page.goto(server.url)
    const entry = page.locator('[data-component="loop-status-entry"]')
    await entry.waitFor()
    const button = await entry.locator("button").elementHandle()
    const heights: number[] = []
    for (const kind of ["blueprint", "lightloop"])
      for (const stage of [
        "bound",
        "running",
        "auditing",
        "paused",
        "rework",
        "resolving",
        "completed",
        "failed",
        "cancelled",
        "timed_out",
        "iteration_exhausted",
        "unavailable",
      ]) {
        await page.evaluate(
          ({ stage, kind }) =>
            (window as unknown as { fixture: { set(stage: string, kind: string): void } }).fixture.set(stage, kind),
          { stage, kind },
        )
        expect(await entry.getAttribute("data-stage")).toBe(stage)
        const bounds = await entry.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
        expect(await entry.getByRole("status").isVisible()).toBe(true)
        expect(await entry.locator("button").evaluate((node, old) => node === old, button)).toBe(true)
        heights.push(bounds!.height)
      }
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })

test("keyboard opens review reasons, live updates retain the dialog, and Escape never pauses the task", async () => {
  await page.setViewportSize({ width: 375, height: 700 })
  await page.goto(server.url)
  await page.evaluate(() => (window as unknown as { fixture: { set(stage: string): void } }).fixture.set("rework"))
  const entry = page.locator('[data-component="loop-status-entry"] button')
  await entry.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog")
  await dialog.waitFor({ state: "visible" })
  expect(await dialog.innerText()).toContain("Missing cancellation coverage")
  const original = await dialog.elementHandle()
  await page.evaluate(() => (window as unknown as { fixture: { set(stage: string): void } }).fixture.set("auditing"))
  expect(await dialog.innerText()).toContain("In review")
  expect(await dialog.evaluate((node, old) => node === old, original)).toBe(true)
  await page.evaluate(() => (window as unknown as { fixture: { set(stage: string): void } }).fixture.set("cancelled"))
  expect(await dialog.innerText()).toContain("Result")
  expect(await dialog.innerText()).not.toContain("Review feedback")
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  expect(await page.evaluate(() => (window as unknown as { fixture: { pauses: number } }).fixture.pauses)).toBe(0)
  expect(errors).toEqual([])
})

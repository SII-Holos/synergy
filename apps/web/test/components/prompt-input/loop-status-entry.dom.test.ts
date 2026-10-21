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
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
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
    import { createSignal, Show } from "solid-js"
    import { I18nProvider } from "@lingui/solid"
    import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
    import { LoopStatusEntry, LoopStatusDialog } from ${JSON.stringify(path.join(app, "src/components/prompt-input/loop-status-entry.tsx"))}
    import { resolveLoopDisplay } from ${JSON.stringify(path.join(app, "src/components/prompt-input/loop-status.ts"))}
    import { i18n } from "./locale"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(path.join(app, "src/index.css"))}
    const [value, setValue] = createSignal({ kind:"blueprint", stage:"bound", title:"A long task title ".repeat(30), reason:"Missing cancellation coverage", terminal:false })
    const [projected, setProjected] = createSignal(false)
    window.fixture = {
      set(stage,kind="blueprint") { setValue({ ...value(), kind, stage, terminal:["completed","failed","cancelled","timed_out","iteration_exhausted"].includes(stage) }) },
      project(status, bound, pending = false, kind = "blueprint") {
        setProjected(true)
        setValue(resolveLoopDisplay({
          blueprint: { id:"loop", sessionID:"session", scopeID:"home", noteID:"note", title:"Previous task", status, source:"user", auditAgent:"supervisor", error:status === "failed" ? "Execution failed" : undefined, time:{created:1,updated:2} },
          blueprintBinding: bound && kind === "blueprint" ? {loopID:"loop", source:"user", loopRole:"execution", phase:"running"} : undefined,
          localBlueprint: pending && kind === "blueprint" ? {type:"pending", noteID:"next", title:"Next task", runMode:"current"} : undefined,
          workflow: bound && kind === "lightloop" ? {kind:"lightloop", instructions:"Current goal"} : undefined,
          lightPending: pending && kind === "lightloop",
          lightTerminal: {status, instructions:"Previous goal", error:"Execution failed", createdAt:2},
          status: {type:"idle"},
        }))
      },
      pauses:0,
    }
    function App() {
      const dialog = useDialog()
      return <div class="prompt-input" style={{width:"100%", "container-type":"inline-size", "container-name":"prompt-input"}} onKeyDown={event => { if(event.key==="Escape") window.fixture.pauses++ }}>
        <Show when={value()}>{current => <LoopStatusEntry value={current()} onRemove={projected() ? () => {} : undefined} onOpen={() => dialog.show(() => <LoopStatusDialog value={value} />)} />}</Show>
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
      {
        find: "@ericsanchezok/synergy-plugin/icons",
        replacement: path.resolve(app, "../../packages/plugin/src/icons.ts"),
      },
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
    const label = entry.locator(".pending-composer-label")
    expect(await label.textContent()).toBe("A long task title ".repeat(30))
    expect(await label.getAttribute("title")).toBe("A long task title ".repeat(30))
    expect(
      await label.evaluate((node) => ({
        truncated: node.scrollWidth > node.clientWidth,
        overflow: getComputedStyle(node).textOverflow,
        wrap: getComputedStyle(node).whiteSpace,
      })),
    ).toEqual({ truncated: true, overflow: "ellipsis", wrap: "nowrap" })
    const button = await entry.locator("button").elementHandle()
    const heights: number[] = []
    for (const kind of ["blueprint", "lightloop"])
      for (const stage of ["bound", "running", "auditing", "paused", "rework", "resolving", "unavailable"]) {
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
        expect(await label.textContent()).toBe("A long task title ".repeat(30))
        expect(await entry.locator("button").evaluate((node, old) => node === old, button)).toBe(true)
        heights.push(bounds!.height)
      }
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })

test.each(["lightloop", "blueprint"])(
  "%s row presence follows binding, not result metadata, and preserves the editor",
  async (kind) => {
    await page.goto(server.url)
    const entry = page.locator('[data-component="loop-status-entry"]')
    const editor = page.getByRole("textbox", { name: "Message" })
    await editor.fill("Keep this draft")
    const original = await editor.elementHandle()
    const project = (status: string, bound: boolean) =>
      page.evaluate(
        ({ status, bound, kind }) =>
          (
            window as unknown as {
              fixture: { project(status: string, bound: boolean, pending: boolean, kind: string): void }
            }
          ).fixture.project(status, bound, false, kind),
        { status, bound, kind },
      )
    await project("running", true)
    expect(await entry.count()).toBe(1)
    for (const stage of kind === "blueprint"
      ? ["failed", "cancelled", "completed"]
      : ["failed", "cancelled", "completed", "timed_out", "iteration_exhausted"]) {
      await project(stage, true)
      expect(await entry.count()).toBe(1)
      expect(await editor.inputValue()).toBe("Keep this draft")
      expect(await editor.evaluate((node, old) => node === old, original)).toBe(true)
    }
    await project("failed", false)
    expect(await entry.count()).toBe(0)
    expect(await editor.inputValue()).toBe("Keep this draft")
    expect(await editor.evaluate((node, old) => node === old, original)).toBe(true)
    expect(errors).toEqual([])
  },
)

test.each(["blueprint", "lightloop"])(
  "an unbound %s leaves no row and never replaces a new intent or draft",
  async (kind) => {
    await page.goto(server.url)
    const entry = page.locator('[data-component="loop-status-entry"]')
    const cancel = entry.getByRole("button", { name: "Cancel loop" })
    const editor = page.getByRole("textbox", { name: "Message" })
    await editor.fill("Keep this draft")
    const original = await editor.elementHandle()
    const project = (status: string, bound: boolean, pending = false) =>
      page.evaluate(
        ({ status, bound, pending, kind }) =>
          (
            window as unknown as {
              fixture: { project(status: string, bound: boolean, pending: boolean, kind: string): void }
            }
          ).fixture.project(status, bound, pending, kind),
        { status, bound, pending, kind },
      )
    await project("running", true)
    expect(await cancel.count()).toBe(1)
    await project("running", false)
    expect(await entry.count()).toBe(0)
    expect(await cancel.count()).toBe(0)
    for (const stage of kind === "blueprint"
      ? ["failed", "cancelled", "completed"]
      : ["failed", "cancelled", "completed", "timed_out", "iteration_exhausted"]) {
      await project(stage, false)
      expect(await entry.count()).toBe(0)
    }
    await project("failed", false, true)
    expect(await entry.count()).toBe(0)
    await project("running", true, true)
    expect(await entry.getAttribute("data-stage")).toBe(kind === "blueprint" ? "running" : "bound")
    expect(await entry.locator(".pending-composer-label").textContent()).toBe(
      kind === "blueprint" ? "Previous task" : "Current goal",
    )
    expect(await cancel.count()).toBe(1)
    expect(await editor.inputValue()).toBe("Keep this draft")
    expect(await editor.evaluate((node, old) => node === old, original)).toBe(true)
    expect(errors).toEqual([])
  },
)

test("keyboard opens review reasons, live updates retain the dialog, and Escape never pauses the task", async () => {
  await page.setViewportSize({ width: 375, height: 700 })
  await page.goto(server.url)
  await page.evaluate(() => (window as unknown as { fixture: { set(stage: string): void } }).fixture.set("rework"))
  const entry = page.locator('[data-component="loop-status-entry"] button')
  await entry.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog")
  await dialog.waitFor({ state: "visible" })
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement))
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
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

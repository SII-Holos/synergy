import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer
let browser: Browser
let page: Page
let fixture: string
let base: string
const appSrc = path.resolve(import.meta.dir, "../../../src")
const errors: string[] = []
beforeAll(async () => {
  fixture = await mkdtemp(path.join(import.meta.dir, ".review-workspace-"))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {SessionReviewTab} from ${JSON.stringify(`/@fs/${appSrc}/components/session/session-review-tab.tsx`)}
    import {TurnChangeSummaryPanel} from "@ericsanchezok/synergy-ui/turn-change-summary-panel"
    const [incomplete,setIncomplete]=createSignal(false)
    const [workspace,setWorkspace]=createSignal({id:"wsp_a",generation:1,path:"/a"})
    const [open,setOpen]=createSignal([])
    const [diffs,setDiffs]=createSignal([{id:"wsp_a",generation:1,root:"/a"},{id:"wsp_b",generation:1,root:"/b"}].map(workspace=>({file:"same.txt",workspace,additions:1,deletions:0,preview:"+"+workspace.root})))
    const h=window.fixture={calls:[],incomplete:()=>setIncomplete(true),locale:(locale)=>i18n.activate(locale),operations:()=>setDiffs(["first","last"].map(operationID=>({file:"same.txt",workspace:{id:"wsp_a",generation:1,root:"/a"},operationID,additions:1,deletions:1,preview:"+"+operationID}))),legacy:()=>setDiffs(["/legacy-a","/legacy-b"].map(legacyRoot=>({file:"same.txt",legacyRoot,additions:1,deletions:0,preview:"+"+legacyRoot}))),switch:()=>setWorkspace({id:"wsp_b",generation:1,path:"/b"}),rebind:()=>setWorkspace({id:"wsp_b",generation:2,path:"/b"})}
    const view=()=>({review:{open,setOpen},scroll:()=>undefined,setScroll(){}})
    const i18n=setupI18n({locale:"en",messages:{en:{},"zh-CN":{"turn-change.recording-incomplete":"文件改动记录尚不完整"}}})
    render(()=><I18nProvider i18n={i18n}><SessionReviewTab workspace={workspace} diffs={diffs} view={view} diffStyle="unified" onViewFile={file=>h.calls.push(file)}/><TurnChangeSummaryPanel diffs={diffs()} state={incomplete()?"error":"ready"} incomplete={incomplete()} onReviewRequested={()=>{}} onFileSelected={file=>h.calls.push(file)}/></I18nProvider>,document.getElementById("root"))
  `,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  server = await createServer({
    configFile: false,
    root: fixture,
    cacheDir: path.join(fixture, ".vite"),
    plugins: [solid()],
    resolve: {
      alias: { "@": appSrc, lru_map: Bun.resolveSync("lru_map", path.resolve(appSrc, "../../../packages/ui")) },
    },
    optimizeDeps: {
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "lru_map"],
      noDiscovery: true,
    },
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [path.resolve(appSrc, "../../.."), fixture] } },
  })
  await server.listen()
  base = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 30_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("same-name historical changes keep independent rows and only open their captured binding", async () => {
  await page.goto(base)
  const rows = page.locator('[data-slot="accordion-item"][data-file]')
  await rows
    .nth(1)
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ errors, html: await page.locator("#root").innerHTML() }), { cause: error })
    })
  expect(
    await rows.evaluateAll((elements) => new Set(elements.map((element) => element.getAttribute("data-file"))).size),
  ).toBe(2)
  await page.getByRole("button", { name: "Expand all" }).click()
  expect(await rows.nth(0).textContent()).toContain("+/a")
  expect(await rows.nth(1).textContent()).toContain("+/b")
  const buttons = page.locator('[data-slot="session-review-view-button"]')
  expect(await buttons.nth(0).isEnabled()).toBe(true)
  expect(await buttons.nth(1).isEnabled()).toBe(false)
  await page.evaluate(() => (window as unknown as { fixture: { switch(): void } }).fixture.switch())
  expect(await buttons.nth(0).isEnabled()).toBe(false)
  await buttons.nth(1).click()
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: string[] } }).fixture.calls)).toEqual([
    "same.txt",
  ])
  await page.evaluate(() => (window as unknown as { fixture: { rebind(): void } }).fixture.rebind())
  expect(await buttons.nth(1).isEnabled()).toBe(false)
  expect(errors).toEqual([])
}, 30_000)

test("legacy files with equal names remain distinct without local file authority", async () => {
  await page.goto(base)
  await page.locator('[data-slot="session-review-view-button"]').nth(1).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { legacy(): void } }).fixture.legacy())
  const rows = page.locator('[data-slot="accordion-item"][data-file]')
  expect(
    await rows.evaluateAll((elements) => new Set(elements.map((element) => element.getAttribute("data-file"))).size),
  ).toBe(2)
  expect(await rows.nth(0).textContent()).toContain("/legacy-a")
  expect(await rows.nth(1).textContent()).toContain("/legacy-b")
  expect(await page.locator('[data-slot="session-review-view-button"]:enabled').count()).toBe(0)
  expect(errors).toEqual([])
}, 30_000)

test("separate writes to the same bound file remain independently expandable", async () => {
  await page.goto(base)
  await page.locator('[data-slot="accordion-item"][data-file]').nth(1).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { operations(): void } }).fixture.operations())
  const rows = page.locator('[data-slot="accordion-item"][data-file]')
  expect(
    await rows.evaluateAll((elements) => new Set(elements.map((element) => element.getAttribute("data-file"))).size),
  ).toBe(2)
  await rows.nth(0).locator('[data-slot="session-review-filename"]').click()
  await rows.nth(0).getByText("+first", { exact: true }).waitFor()
  expect(await rows.nth(0).textContent()).toContain("+first")
  expect(await rows.nth(1).textContent()).not.toContain("+last")
  await rows.nth(1).locator('[data-slot="session-review-filename"]').click()
  await rows.nth(1).getByText("+last", { exact: true }).waitFor()
  expect(await rows.nth(1).textContent()).toContain("+last")
})

test("incomplete recording remains visible with the available file changes in both languages", async () => {
  await page.goto(base)
  const panel = page.locator('[data-component="turn-change-summary-panel"]')
  await panel.waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { incomplete(): void } }).fixture.incomplete())
  expect(await panel.textContent()).toContain("File change recording is incomplete")
  expect(await panel.locator('[data-slot="turn-change-summary-row"]').count()).toBe(2)
  await page.evaluate(() => (window as unknown as { fixture: { locale(value: string): void } }).fixture.locale("zh-CN"))
  expect(await panel.textContent()).toContain("文件改动记录尚不完整")
})

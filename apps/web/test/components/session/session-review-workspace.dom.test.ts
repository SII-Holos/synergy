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
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import "@ericsanchezok/synergy-ui/styles"
    import {ThemeProvider,useTheme} from "@ericsanchezok/synergy-ui/theme"
    import {SessionReviewTab} from ${JSON.stringify(`/@fs/${appSrc}/components/session/session-review-tab.tsx`)}
    import {TurnChangeSummaryPanel} from "@ericsanchezok/synergy-ui/turn-change-summary-panel"
    const [incomplete,setIncomplete]=createSignal(false)
    const [pending,setPending]=createSignal(false)
    const [failed,setFailed]=createSignal(false)
    const [workspace,setWorkspace]=createSignal({id:"wsp_a",generation:1,path:"/a"})
    const [open,setOpen]=createSignal([])
    const [diffs,setDiffs]=createSignal([{id:"wsp_a",generation:1,root:"/a"},{id:"wsp_b",generation:1,root:"/b"}].map(workspace=>({file:"same.txt",workspace,additions:1,deletions:0,preview:"+"+workspace.root})))
    const h=window.fixture={calls:[],loads:[],reviews:0,undos:0,metadata:()=>setDiffs([{file:"compact.txt",workspace:{id:"wsp_a",generation:1,root:"/a"},additions:1,deletions:0}]),pending:()=>setPending(true),ready:()=>setPending(false),incomplete:()=>setIncomplete(true),error:()=>setFailed(true),empty:()=>setDiffs([]),locale:(locale)=>i18n.activate(locale),operations:()=>setDiffs(["first","last"].map(operationID=>({file:"same.txt",workspace:{id:"wsp_a",generation:1,root:"/a"},operationID,additions:1,deletions:1,preview:"+"+operationID}))),legacy:()=>setDiffs(["/legacy-a","/legacy-b"].map(legacyRoot=>({file:"same.txt",legacyRoot,additions:1,deletions:0,preview:"+"+legacyRoot}))),switch:()=>setWorkspace({id:"wsp_b",generation:1,path:"/b"}),rebind:()=>setWorkspace({id:"wsp_b",generation:2,path:"/b"})}
    const view=()=>({review:{open,setOpen},scroll:()=>undefined,setScroll(){}})
    const i18n=setupI18n({locale:"en",messages:{en:{},"zh-CN":{"ui.turnChangeSummary.title":"已更改 {fileCount} 个文件","ui.turnChangeSummary.undo":"撤销","turn-change.review-changes":"查看更改"}}})
    function Content(){
      const theme=useTheme()
      h.theme=theme.setColorScheme
      return <><div style="height:360px;display:flex;flex-direction:column;min-height:0"><SessionReviewTab workspace={workspace} diffs={diffs} loadDiff={async(diff)=>{h.loads.push(diff.file);return {...diff,preview:"+complete historical content"}}} diffState={()=>incomplete()?{status:"error",code:"incomplete"}:undefined} view={view} diffStyle="unified" onViewFile={file=>h.calls.push(file)}/></div><TurnChangeSummaryPanel diffs={diffs()} state={pending()?"pending":failed()?"error":incomplete()?"partial":"ready"} onUndoRequested={()=>h.undos++} onReviewRequested={()=>h.reviews++} onFileSelected={file=>h.calls.push(file)}/></>
    }
    render(()=><I18nProvider i18n={i18n}><ThemeProvider><Content/></ThemeProvider></I18nProvider>,document.getElementById("root"))
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
  page.setDefaultNavigationTimeout(20_000)
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
}, 30_000)

test("incomplete recording stays quiet in the card while Review explains the limits", async () => {
  await page.goto(base)
  await page.locator('[data-component="turn-change-summary-panel"]').waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { incomplete(): void } }).fixture.incomplete())
  const card = page.locator('[data-component="turn-change-summary-panel"]')
  expect(await card.count()).toBe(1)
  expect(await card.getAttribute("aria-label")).toBe("Changed 2 files")
  expect(await card.getByRole("status").count()).toBe(0)
  expect(await page.locator('[data-slot="turn-change-summary-row"]').count()).toBe(2)
  const notice = page.locator('[data-slot="review-recording-notice"]')
  expect(await notice.textContent()).toContain("This does not mean no files changed")
  expect(await page.locator('[data-slot="session-review-view-button"]').count()).toBe(2)
  await page.evaluate(() => (window as unknown as { fixture: { empty(): void } }).fixture.empty())
  expect(await notice.textContent()).toContain("This does not mean no files changed")
  expect(await card.count()).toBe(0)
  expect(await page.locator('[data-slot="turn-change-summary-entry"]').count()).toBe(0)
  expect(errors).toEqual([])
})

test("settlement retains the file card, rows and actions without recording notices", async () => {
  await page.goto(base)
  const card = page.locator('[data-component="turn-change-summary-panel"]')
  await card.waitFor()
  await card.evaluate((element) => element.setAttribute("data-retained", "yes"))
  await page
    .locator('[data-slot="turn-change-summary-row"]')
    .first()
    .evaluate((element) => element.setAttribute("data-retained", "yes"))
  for (const transition of ["pending", "ready", "incomplete", "error"] as const) {
    await page.evaluate(
      (key) => (window as unknown as { fixture: Record<string, () => void> }).fixture[key]!(),
      transition,
    )
    expect(await card.getAttribute("data-retained")).toBe("yes")
    expect(await card.getAttribute("aria-label")).toBe("Changed 2 files")
    expect(await card.getByRole("status").count()).toBe(0)
    expect(await card.locator('[data-slot="review-recording-notice"]').count()).toBe(0)
    expect(await card.getAttribute("aria-busy")).toBe(transition === "pending" ? "true" : null)
    expect(await card.getByRole("button", { name: "Undo", exact: true }).isEnabled()).toBe(transition !== "pending")
    expect(await page.locator('[data-slot="turn-change-summary-row"]').first().getAttribute("data-retained")).toBe(
      "yes",
    )
    expect(await page.locator('[data-slot="turn-change-summary-row"]').count()).toBe(2)
  }
})

test("opening a file with Enter does not toggle its diff", async () => {
  await page.goto(base)
  const button = page.locator('[data-slot="session-review-view-button"]').first()
  await button.waitFor()
  await button.focus()
  await page.keyboard.press("Enter")
  expect(await page.evaluate(() => (window as unknown as { fixture: { calls: string[] } }).fixture.calls)).toEqual([
    "same.txt",
  ])
  expect(await button.evaluate((element) => element.parentElement?.closest("button"))).toBeNull()
})

test("compact summaries load historical content even without the truncated flag", async () => {
  await page.goto(base)
  await page.locator('[data-slot="session-review-view-button"]').first().waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { metadata(): void } }).fixture.metadata())
  await page.getByRole("button", { name: "Expand all" }).click()
  await page.getByText("+complete historical content", { exact: true }).waitFor()
  expect(await page.evaluate(() => (window as unknown as { fixture: { loads: string[] } }).fixture.loads)).toEqual([
    "compact.txt",
  ])
})

test("an empty comparison has an explanation and no enabled expand action", async () => {
  await page.goto(base)
  await page.locator('[data-slot="session-review-view-button"]').first().waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { empty(): void } }).fixture.empty())
  await page.getByText("No changes", { exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Expand all" }).isEnabled()).toBe(false)
})
test("the change card keeps a compact summary and reachable actions in both locales and themes", async () => {
  await page.setViewportSize({ width: 960, height: 700 })
  await page.goto(base)
  const card = page.locator('[data-component="turn-change-summary-panel"]')
  await card.waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { incomplete(): void } }).fixture.incomplete())
  for (const locale of ["en", "zh-CN"]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        ({ locale, theme }) => {
          const fixture = (
            window as unknown as { fixture: { locale(value: string): void; theme(value: string): void } }
          ).fixture
          fixture.locale(locale)
          fixture.theme(theme)
        },
        { locale, theme },
      )
      await page.setViewportSize({ width: 960, height: 700 })
      expect(await card.getAttribute("aria-label")).toBe(locale === "en" ? "Changed 2 files" : "已更改 2 个文件")
      const geometry = await card.evaluate((element) => {
        const bounds = (selector: string) => element.querySelector(selector)!.getBoundingClientRect()
        return {
          header: bounds('[data-slot="turn-change-summary-header"]').height,
          row: bounds('[data-slot="turn-change-summary-row"]').height,
          title: bounds('[data-slot="turn-change-summary-title"]').top,
          counts: bounds('[data-slot="turn-change-summary-title-copy"] [data-component="diff-changes"]').top,
        }
      })
      expect(geometry.header).toBeLessThanOrEqual(geometry.row + 2)
      expect(Math.abs(geometry.title - geometry.counts)).toBeLessThan(8)
      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 700 })
        const fits = await card.evaluate((element) => {
          const card = element.getBoundingClientRect()
          return [...element.querySelectorAll("button")].every((button) => {
            const bounds = button.getBoundingClientRect()
            return bounds.left >= card.left && bounds.right <= card.right && bounds.height >= 24
          })
        })
        expect(fits).toBe(true)
      }
    }
  }
  await page.evaluate(() => (window as unknown as { fixture: { locale(value: string): void } }).fixture.locale("en"))
  const undo = card.getByRole("button", { name: "Undo", exact: true })
  await undo.focus()
  await page.keyboard.press("Enter")
  await card.getByRole("button", { name: "Review changes", exact: true }).click()
  expect(
    await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: { undos: number; reviews: number } }).fixture
      return { undos: fixture.undos, reviews: fixture.reviews }
    }),
  ).toEqual({ undos: 1, reviews: 1 })
  expect(errors).toEqual([])
}, 30_000)

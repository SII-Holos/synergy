import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { preview, type PreviewServer } from "vite"

let server: PreviewServer
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
    import {createSignal,Show} from "solid-js"
    import {MetaProvider} from "@solidjs/meta"
    import {Font} from "@ericsanchezok/synergy-ui/font"

    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {messages as enMessages} from ${JSON.stringify(`${appSrc}/locales/en/messages.po`)}
    import {messages as zhMessages} from ${JSON.stringify(`${appSrc}/locales/zh-CN/messages.po`)}
    import "@ericsanchezok/synergy-ui/styles"
    import {ThemeProvider,useTheme} from "@ericsanchezok/synergy-ui/theme"
    import {SessionReviewTab} from ${JSON.stringify(`${appSrc}/components/session/session-review-tab.tsx`)}
    import {TurnChangeSummaryPanel} from "@ericsanchezok/synergy-ui/turn-change-summary-panel"
    const [incomplete,setIncomplete]=createSignal(false)
    const [pending,setPending]=createSignal(false)
    const [failed,setFailed]=createSignal(false)
    const [workspace,setWorkspace]=createSignal({id:"wsp_a",generation:1,path:"/a"})
    const [open,setOpen]=createSignal([])
    const [selected,setSelected]=createSignal()
    const [shown,setShown]=createSignal(true)
    const [comparison,setComparison]=createSignal("first")
    const [diffs,setDiffs]=createSignal([{id:"wsp_a",generation:1,root:"/a"},{id:"wsp_b",generation:1,root:"/b"}].map(workspace=>({file:"same.txt",workspace,additions:1,deletions:0,preview:"+"+workspace.root})))
    const h=window.fixture={calls:[],loads:[],reviews:0,metadata:()=>setDiffs([{file:"compact.txt",workspace:{id:"wsp_a",generation:1,root:"/a"},additions:1,deletions:0}]),pending:()=>setPending(true),ready:()=>setPending(false),incomplete:()=>setIncomplete(true),error:()=>setFailed(true),empty:()=>setDiffs([]),locale:(locale)=>i18n.activate(locale),operations:()=>setDiffs(["first","last"].map(operationID=>({file:"same.txt",workspace:{id:"wsp_a",generation:1,root:"/a"},operationID,additions:1,deletions:1,preview:"+"+operationID}))),legacy:()=>setDiffs(["/legacy-a","/legacy-b"].map(legacyRoot=>({file:"same.txt",legacyRoot,additions:1,deletions:0,preview:"+"+legacyRoot}))),switch:()=>setWorkspace({id:"wsp_b",generation:1,path:"/b"}),rebind:()=>setWorkspace({id:"wsp_b",generation:2,path:"/b"})}
    h.large=()=>{setOpen([]);setDiffs(Array.from({length:512},(_,i)=>({file:"file-"+String(i).padStart(4,"0")+".txt",workspace:{id:"wsp_a",generation:1,root:"/a"},additions:1,deletions:0})));};h.select=(file)=>setSelected(file);h.reverse=()=>setDiffs(files=>[...files].reverse());h.long=()=>setDiffs(files=>files.map(file=>({...file,workspace:{...file.workspace,root:"/workspaces/engineering/large-workspace"}})));h.nextComparison=()=>setComparison("second");h.close=()=>setShown(false);h.open=()=>setShown(true);h.stats=()=>setDiffs(files=>files.map(file=>({...file,additions:file.additions+1})));h.tall=()=>setDiffs(files=>files.map((file,index)=>index?file:{...file,preview:Array.from({length:100},(_,i)=>"+line "+i).join("\\n")}))
    let savedScroll;const savedView={review:{open,setOpen},scroll:()=>savedScroll,setScroll(_tab,value){savedScroll=value}};const view=()=>savedView

    const i18n=setupI18n({locale:"en",messages:{en:enMessages,"zh-CN":zhMessages}})
    function Content(){
      const theme=useTheme()
      h.theme=theme.setColorScheme
      return <><div style="height:360px;display:flex;flex-direction:column;min-height:0"><Show when={shown()}><SessionReviewTab comparisonKey={comparison()} selectedFile={selected} workspace={workspace} diffs={diffs} loadDiff={async(diff)=>{h.loads.push(diff.file);return {...diff,preview:diff.additions>1?"+refreshed historical content":"+complete historical content"}}} diffState={()=>incomplete()?{status:"error",code:"incomplete"}:undefined} view={view} diffStyle="unified" onViewFile={file=>h.calls.push(file)}/></Show></div><Show when={diffs().length<100}><TurnChangeSummaryPanel diffs={diffs()} state={pending()?"pending":failed()?"error":incomplete()?"partial":"ready"} onReviewRequested={()=>h.reviews++} onFileSelected={file=>h.calls.push(file)}/></Show></>

    }
    render(()=><MetaProvider><Font/><I18nProvider i18n={i18n}><ThemeProvider><Content/></ThemeProvider></I18nProvider></MetaProvider>,document.getElementById("root"))
  `,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  const options = {
    configFile: false,
    logLevel: "error",
    root: fixture,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    worker: { format: "es" },
    resolve: {
      alias: { "@": appSrc, lru_map: Bun.resolveSync("lru_map", path.resolve(appSrc, "../../../packages/ui")) },
    },
    build: {
      outDir: path.join(fixture, "dist"),
      minify: false,
      target: "esnext",
      lib: { entry: path.join(fixture, "main.tsx"), formats: ["es"], fileName: "main", cssFileName: "styles" },
    },
  }
  const builder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {build} from ${JSON.stringify(Bun.resolveSync("vite", import.meta.dir))}; import solidPlugin from ${JSON.stringify(Bun.resolveSync("vite-plugin-solid", import.meta.dir))}; import lingui from ${JSON.stringify(Bun.resolveSync("@lingui/vite-plugin", import.meta.dir))}; await build({... ${JSON.stringify(options)}, plugins:[solidPlugin(),...lingui({configPath:${JSON.stringify(path.resolve(appSrc, "../lingui.config.ts"))}})]}); process.exit(0)`,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "inherit", stderr: "inherit" },
  )
  if (await builder.exited) throw new Error("Review workspace fixture build failed")
  await Bun.write(
    path.join(fixture, "dist/index.html"),
    '<!doctype html><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/main.js"></script>',
  )
  server = await preview({
    configFile: false,
    root: fixture,
    preview: { host: "127.0.0.1", port, strictPort: true },
  })
  base = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.setDefaultNavigationTimeout(20_000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 120_000)
afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
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
    expect(await card.getByRole("button", { name: "Undo", exact: true }).count()).toBe(0)
    expect(await card.getByRole("button", { name: "Review changes", exact: true }).isEnabled()).toBe(true)
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
      expect(await card.getByRole("button", { name: locale === "en" ? "Undo" : "撤销", exact: true }).count()).toBe(0)
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
  const review = card.getByRole("button", { name: "Review changes", exact: true })
  await review.focus()
  await page.keyboard.press("Enter")
  expect(
    await page.evaluate(() => {
      const fixture = (window as unknown as { fixture: { reviews: number } }).fixture
      return fixture.reviews
    }),
  ).toBe(1)
  expect(errors).toEqual([])
}, 30_000)

test("large reviews keep rendering bounded while keyboard navigation and selected files reach the full comparison", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(base)
  await page.locator('[data-slot="accordion-item"][data-file]').nth(1).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { large(): void } }).fixture.large())
  const review = page.locator('[data-component="session-review"]')
  const rows = review.locator('[data-slot="accordion-item"][data-file]')
  await review.getByText("file-0000.txt", { exact: true }).waitFor()
  expect(await rows.count()).toBeLessThan(80)
  expect(await page.evaluate(() => (window as unknown as { fixture: { loads: string[] } }).fixture.loads)).toEqual([])
  await rows.first().locator('[data-slot="accordion-trigger"]').focus()
  await page.keyboard.press("End")
  const last = review.getByText("file-0511.txt", { exact: true })
  await last.waitFor()
  expect(await last.evaluate((el) => el.closest("button") === document.activeElement)).toBe(true)
  await page.keyboard.press("Enter")
  await review.getByText("+complete historical content", { exact: true }).waitFor()
  expect(await rows.count()).toBeLessThan(80)
  await page.evaluate(() =>
    (window as unknown as { fixture: { select(file: string): void } }).fixture.select("file-0250.txt"),
  )
  const selected = review.locator('[data-slot="accordion-item"][data-selected="true"]')
  await selected.getByText("file-0250.txt", { exact: true }).waitFor()
  expect(
    await selected.evaluate((el) => {
      const a = el.getBoundingClientRect(),
        b = el.closest('[data-component="session-review"]')!.getBoundingClientRect()
      return a.bottom > b.top && a.top < b.bottom
    }),
  ).toBe(true)
  await selected.getByText("+complete historical content", { exact: true }).waitFor()
  await selected.evaluate((el) => el.setAttribute("data-retained", "yes"))
  await page.evaluate(() => (window as unknown as { fixture: { reverse(): void } }).fixture.reverse())
  expect(await selected.getAttribute("data-retained")).toBe("yes")
  const content = selected.getByText("+complete historical content", { exact: true })
  await content.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await review.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await review.getByText("file-0000.txt", { exact: true }).waitFor()
  expect(await selected.count()).toBe(1)
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("+complete historical content")
  await page.evaluate(() => document.getSelection()?.removeAllRanges())
  await page.getByRole("button", { name: "Collapse all" }).click()
  await page.getByRole("button", { name: "Expand all" }).click()
  expect(await rows.count()).toBeLessThan(80)
  expect(
    (await page.evaluate(() => (window as unknown as { fixture: { loads: string[] } }).fixture.loads)).length,
  ).toBeLessThan(80)
  await page.evaluate(() => (window as unknown as { fixture: { close(): void } }).fixture.close())
  await review.waitFor({ state: "hidden" })
  expect(errors).toEqual([])
}, 30_000)

test("refreshing identical file identities preserves the current reading position", async () => {
  await page.goto(base)
  await page.locator('[data-slot="accordion-item"][data-file]').nth(1).waitFor()
  await page.evaluate(() => {
    const h = (window as unknown as { fixture: { large(): void; select(file: string): void } }).fixture
    h.large()
    h.select("file-0000.txt")
  })
  const review = page.locator('[data-component="session-review"]')
  await page.waitForFunction(() =>
    document.activeElement?.closest("[data-file]")?.textContent?.includes("file-0000.txt"),
  )
  await review.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await review.getByText("file-0511.txt", { exact: true }).waitFor()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 10
        const tick = () => (--frames ? requestAnimationFrame(tick) : resolve())
        requestAnimationFrame(tick)
      }),
  )
  const before = await review.evaluate((el) => el.scrollTop)
  await page.evaluate(() => (window as unknown as { fixture: { stats(): void } }).fixture.stats())
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 10
        const tick = () => (--frames ? requestAnimationFrame(tick) : resolve())
        requestAnimationFrame(tick)
      }),
  )
  expect(Math.abs((await review.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(2)
}, 30_000)

test("reopening a review restores its file anchor after an earlier large expanded diff", async () => {
  await page.goto(base)
  await page.locator('[data-slot="accordion-item"][data-file]').nth(1).waitFor()
  await page.evaluate(() => {
    const h = (window as unknown as { fixture: { large(): void; tall(): void } }).fixture
    h.large()
    h.tall()
  })
  const review = page.locator('[data-component="session-review"]')
  await review.getByText("file-0000.txt", { exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('[data-slot="accordion-item"][data-file]')!.getBoundingClientRect().height > 400,
  )
  await review.evaluate((el) => {
    el.scrollTop = 4000
  })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const reading = () =>
    review.evaluate((el) => {
      const top = el.getBoundingClientRect().top
      const row = [...el.querySelectorAll<HTMLElement>('[data-slot="accordion-item"][data-file]')].find((row) => {
        const bounds = row.getBoundingClientRect()
        return bounds.top <= top + 100 && bounds.bottom > top + 100
      })!
      return { key: row.dataset.file, offset: row.getBoundingClientRect().top - top }
    })
  const before = await reading()
  await page.evaluate(() => (window as unknown as { fixture: { close(): void } }).fixture.close())
  await review.waitFor({ state: "hidden" })
  await page.evaluate(() => (window as unknown as { fixture: { open(): void } }).fixture.open())
  await review.waitFor()
  await page.waitForFunction(
    (key) =>
      [...document.querySelectorAll<HTMLElement>('[data-slot="accordion-item"][data-file]')].some(
        (row) => row.dataset.file === key,
      ),
    before.key,
  )
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const after = await reading()
  expect(after.key).toBe(before.key)
  expect(Math.abs(after.offset - before.offset)).toBeLessThan(3)
}, 30_000)

test("refreshing metadata reloads an expanded file without replacing its disclosure", async () => {
  await page.goto(base)
  await page.locator('[data-slot="accordion-item"][data-file]').nth(1).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { large(): void } }).fixture.large())
  const review = page.locator('[data-component="session-review"]')
  await review.getByText("file-0000.txt", { exact: true }).click()
  await review.getByText("+complete historical content", { exact: true }).waitFor()
  const header = await review.getByText("file-0000.txt", { exact: true }).elementHandle()
  await page.evaluate(() => (window as unknown as { fixture: { stats(): void } }).fixture.stats())
  await review.getByText("+refreshed historical content", { exact: true }).waitFor()
  expect(await header!.evaluate((el) => el.isConnected)).toBe(true)
  expect(errors).toEqual([])
}, 30_000)

test("a different comparison does not inherit the previous turn reading position", async () => {
  await page.goto(base)
  await page.locator('[data-slot="accordion-item"][data-file]').nth(1).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { large(): void } }).fixture.large())
  const review = page.locator('[data-component="session-review"]')
  await review.getByText("file-0000.txt", { exact: true }).waitFor()
  await review.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await review.getByText("file-0511.txt", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as { fixture: { close(): void } }).fixture.close())
  await review.waitFor({ state: "hidden" })
  await page.evaluate(() => {
    const h = (window as unknown as { fixture: { nextComparison(): void; open(): void } }).fixture
    h.nextComparison()
    h.open()
  })
  await review.waitFor()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 10
        const tick = () => (--frames ? requestAnimationFrame(tick) : resolve())
        requestAnimationFrame(tick)
      }),
  )
  expect(await review.evaluate((el) => el.scrollTop)).toBe(0)
}, 30_000)

test("narrow Review prioritizes the filename over long workspace prefixes", async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  try {
    await page.goto(base)
    await page.locator('[data-slot="accordion-item"][data-file]').nth(1).waitFor()
    await page.evaluate(() => {
      const h = (window as unknown as { fixture: { large(): void; long(): void } }).fixture
      h.large()
      h.long()
    })
    const filename = page.locator('[data-slot="session-review-filename"]').filter({ hasText: "file-0000.txt" })
    await filename.waitFor()
    expect(await filename.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 })
  }
}, 30_000)

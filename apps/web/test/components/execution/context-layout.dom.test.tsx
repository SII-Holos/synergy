import { afterAll, beforeAll, expect, test } from "bun:test"
import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { preview, type PreviewServer } from "vite"

let browser: Browser
let page: Page
let server: PreviewServer
let directory: string
const source = path.resolve(import.meta.dir, "../../../src/components/execution")
beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "synergy-context-layout-")))
  await symlink(path.resolve(source, "../../../node_modules"), path.join(directory, "node_modules"), "dir")
  await Bun.write(path.join(directory, "package.json"), '{"type":"module"}')
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import { setupI18n } from "@lingui/core"
    import { I18nProvider } from "@lingui/solid"
    import { ContextDashboardLayout } from ${JSON.stringify(path.join(source, "context-dashboard-layout.tsx"))}
    import { ContextComposition } from ${JSON.stringify(path.join(source, "context-composition.tsx"))}
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(path.join(source, "context-dashboard.css"))}
    const categories=["systemInstructions","toolDefinitions","userMessages","injectedContext","skills","assistantMessages","toolResults","attachments"].map((category,index)=>({category,precision:"source",items:index,estimatedTokens:100,attributedTokens:100}))
    const snapshot={callID:"selected",requestNumber:1,roundNumber:1,modelID:"test-model",inputTokens:1000,contextLimit:10000,usage:{categories,overhead:{attributedTokens:200}}}
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><div class="context-dashboard-shell" style="height:100dvh"><div class="context-dashboard"><ContextDashboardLayout
      composition={<ContextComposition snapshot={snapshot} category="" onCategory={()=>{}}/>}
      metrics={<section class="context-usage-stats"><div class="context-metrics">{["Cost","Time","Cache"].map(name=><button class="context-metric"><span>{name}</span><strong>1,234</strong></button>)}</div></section>}
      history={<section class="context-history"><h2>History</h2><div class="context-history-plot"/></section>}
      timing={<section class="context-timing"><h2>Timing</h2><div style="height:120px"/></section>}
      contents={<section class="context-browser"><h2>Contents</h2><label class="context-source-search"><input aria-label="Search sources"/></label><button id="reader">Read source</button><div style="height:210px"/></section>}
      events={<section class="context-events"><h2>Events</h2></section>}
      activity={<section class="context-activity"><h2>Task activity</h2></section>}
    /></div></div></I18nProvider>, document.getElementById("root"))
  `,
  )
  const options = {
    configFile: false,
    logLevel: "error",
    root: directory,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: path.join(directory, "dist"),
      minify: false,
      target: "esnext",
      lib: { entry: path.join(directory, "main.tsx"), formats: ["es"], fileName: "main", cssFileName: "styles" },
    },
  }
  const builder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {build} from ${JSON.stringify(Bun.resolveSync("vite", import.meta.dir))}; import solid from ${JSON.stringify(Bun.resolveSync("vite-plugin-solid", import.meta.dir))}; await build({...${JSON.stringify(options)},plugins:[solid()]});process.exit(0)`,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "inherit", stderr: "inherit" },
  )
  if (await builder.exited) throw new Error("Context layout build failed")
  await Bun.write(
    path.join(directory, "dist/index.html"),
    '<!doctype html><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/main.js"></script>',
  )
  server = await preview({
    configFile: false,
    root: directory,
    preview: { host: "127.0.0.1", port: await fixturePort() },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
}, 60_000)
afterAll(async () => {
  await browser?.close()
  if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})
for (const width of [320, 375, 560, 800, 1280, 1989]) {
  test(`context reading layout fits ${width}px without stretching its columns`, async () => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(server.resolvedUrls!.local[0]!)
    await page.locator(".context-composition").waitFor()
    const result = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector)!
        const rect = el.getBoundingClientRect()
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width }
      }
      const scroller = document.querySelector(".context-dashboard")!
      return {
        composition: box(".context-composition"),
        content: box(".context-browser"),
        timing: box(".context-timing"),
        history: box(".context-history"),
        metric: box(".context-metrics"),
        overflow: scroller.scrollWidth > scroller.clientWidth,
        clippedLabels: [...document.querySelectorAll(".context-legend-row > span:nth-child(2)")].filter(
          (label) => label.scrollWidth > label.clientWidth,
        ).length,
      }
    })
    expect(result.overflow).toBe(false)
    expect(result.clippedLabels).toBe(0)
    if (width >= 800) {
      expect(result.content.x).toBeGreaterThan(result.composition.right)
      expect(result.content.y).toBeLessThan(340)
      expect(result.history.width).toBeLessThanOrEqual(790)
      expect(result.metric.bottom - result.metric.y).toBeLessThan(160)
    } else {
      expect(result.content.y).toBeGreaterThan(result.history.bottom)
      expect(result.timing.y).toBeGreaterThan(result.history.bottom)
      if (width === 560) expect(result.history.y).toBeLessThan(640)
    }
  })
}
test("changing layout retains the reader node, typed search and keyboard focus", async () => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(server.resolvedUrls!.local[0]!)
  const search = page
    .getByRole("searchbox", { name: "Search sources" })
    .or(page.getByRole("textbox", { name: "Search sources" }))
  await search.fill("requirements")
  await page.evaluate(() => {
    document.querySelector("input")!.dataset.retained = "yes"
  })
  for (const width of [375, 1989, 560, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    expect(await search.inputValue()).toBe("requirements")
    expect(await search.getAttribute("data-retained")).toBe("yes")
    expect(await search.evaluate((element) => document.activeElement === element)).toBe(true)
  }
})

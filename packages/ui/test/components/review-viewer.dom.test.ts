import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let directory: string, server: ViteDevServer, browser: Browser, page: Page, url: string
const errors: string[] = []
beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".review-viewer-"))
  const component = path.resolve(import.meta.dir, "../../src/components/review-viewer.tsx")
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal} from "solid-js"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {parseDiffFromFile} from "@pierre/diffs"
    import {ReviewViewer} from ${JSON.stringify(component)}
    const before=Array.from({length:20000},(_,index)=>"export const row"+index+" = "+index+"\\n").join("")
    const entries=Array.from({length:120},(_,index)=>({id:"file-"+index,type:"diff",version:1,fileDiff:parseDiffFromFile({name:"file"+index+".ts",contents:index===0?before:"old\\n"},{name:"file"+index+".ts",contents:index===0?before.replace("row5 = 5","row5 = 500"):"new"+index+"\\n"})}))
    const [selected,setSelected]=createSignal("file-0"),[items,setItems]=createSignal(entries),[full,setFull]=createSignal(true),[selection,setSelection]=createSignal(null),[style,setStyle]=createSignal("unified")
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><><button onClick={()=>setSelected("file-119")}>Last file</button><button onClick={()=>setSelected("file-60")}>Middle file</button><button onClick={()=>setSelected("file-0")}>First file</button><button onClick={()=>setStyle(style()==="unified"?"split":"unified")}>Toggle layout</button><button onClick={()=>setFull(!full())}>Toggle full</button><button onClick={()=>setItems(items().map(item=>({...item,version:item.version+1,collapsed:!item.collapsed})))}>Toggle folds</button><output>{JSON.stringify(selection())}</output><div style={{height:"500px",width:"640px"}}><ReviewViewer items={items()} selected={selected()} style={style()} wrap words full={full()} whitespace={false} renderHeader={id=><button style={{height:"41px"}} aria-label={id}>{id}</button>} onSelection={setSelection} onError={error=>{throw error}} /></div></></I18nProvider>,document.getElementById("root"))
  `,
  )
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  await reservation.stop(true)
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid()],
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      fs: { allow: [path.resolve(import.meta.dir, "../../../.."), directory] },
    },
    optimizeDeps: {
      include: [
        "solid-js",
        "solid-js/web",
        "@pierre/diffs",
        "@pierre/diffs/worker",
        "lru_map",
        "@lingui/core",
        "@lingui/solid",
      ],
      noDiscovery: true,
    },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 6 })
  page.setDefaultNavigationTimeout(30_000)
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("continuous review bounds a full large file and reaches distant files without losing selection", async () => {
  await page.goto(url)
  await page.addStyleTag({ content: '[data-component="review-viewer"]{height:100%;overflow:auto}' })
  await page
    .getByRole("button", { name: "file-0", exact: true })
    .waitFor()
    .catch(async (cause) => {
      throw new Error(JSON.stringify({ errors, html: (await page.locator("body").innerHTML()).slice(0, 1500) }), {
        cause,
      })
    })
  const counts = await page.evaluate(() => {
    const nodes: Element[] = []
    const walk = (root: ParentNode) => {
      for (const node of root.querySelectorAll("*")) {
        nodes.push(node)
        if (node.shadowRoot) walk(node.shadowRoot)
      }
    }
    walk(document.querySelector('[data-component="review-viewer"]')!)
    return { nodes: nodes.length, lines: nodes.filter((node) => node.hasAttribute("data-line")).length }
  })
  expect(counts.lines).toBeGreaterThan(0)
  expect(counts.lines).toBeLessThan(200)
  expect(counts.nodes).toBeLessThan(3000)
  await page.getByRole("button", { name: "Middle file", exact: true }).click()
  await page.getByText("new60", { exact: true }).waitFor()
  const middle = page
    .locator("diffs-container")
    .filter({ has: page.getByRole("button", { name: "file-60", exact: true }) })
  const middleHeader = await middle.locator("[data-review-header]").boundingBox()
  const middleLine = await middle.getByRole("button", { name: "Select line 1 in after", exact: true }).boundingBox()
  expect(middleLine!.y).toBeGreaterThanOrEqual(middleHeader!.y + middleHeader!.height - 1)
  await page.getByRole("button", { name: "Last file", exact: true }).click()
  await page.getByText("new119", { exact: true }).waitFor()
  const last = page
    .locator("diffs-container")
    .filter({ has: page.getByRole("button", { name: "file-119", exact: true }) })
  const header = await last.locator("[data-review-header]").boundingBox()
  const firstLine = await last.getByRole("button", { name: "Select line 1 in after", exact: true }).boundingBox()
  expect(firstLine!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1)
  const connected = await last
    .getByRole("button", { name: "Select line 1 in after", exact: true })
    .evaluate((element) => {
      const toggle = [...document.querySelectorAll("button")].find((button) => button.textContent === "Toggle layout")!
      toggle.click()
      ;(element as HTMLElement).click()
      return element.isConnected
    })
  expect(connected).toBe(true)
  expect(await page.locator("output").textContent()).toContain('"start":1')
  for (const side of ["before", "after", "before", "after"]) {
    await page.getByRole("button", { name: "Toggle layout", exact: true }).click()
    await last.getByRole("button", { name: `Select line 1 in ${side}`, exact: true }).click()
    expect(JSON.parse((await page.locator("output").textContent())!)).toEqual({
      id: "file-119",
      range: { start: 1, end: 1, side: side === "before" ? "deletions" : "additions" },
    })
  }
  await page
    .locator("diffs-container")
    .filter({ has: page.getByRole("button", { name: "file-119", exact: true }) })
    .getByRole("button", { name: "Select line 1 in after", exact: true })
    .click()
  expect(await page.locator("output").textContent()).toContain('"start":1')
  await page.getByRole("button", { name: "Toggle layout", exact: true }).click()
  await page.getByRole("button", { name: "First file", exact: true }).click()
  await page.getByText("export const row5 = 500", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Toggle full", exact: true }).click()
  await page.getByText("export const row5 = 500", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Select line 6 in after", exact: true }).click()
  expect(await page.locator("output").textContent()).toContain('"start":6')
  await page.getByRole("button", { name: "Select line 7 in after", exact: true }).press("Enter")
  expect(await page.locator("output").textContent()).toContain('"start":7')
  await page.getByRole("button", { name: "Select line 8 in after", exact: true }).click({ modifiers: ["Shift"] })
  expect(JSON.parse((await page.locator("output").textContent())!)).toEqual({
    id: "file-0",
    range: { start: 7, end: 8, side: "additions" },
  })
  await page.getByRole("button", { name: "Toggle folds", exact: true }).click()
  await page.getByRole("button", { name: "file-0", exact: true }).waitFor()
  await page.getByText("export const row5 = 500", { exact: true }).waitFor({ state: "hidden" })
  expect(await page.getByText("export const row5 = 500", { exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
}, 60_000)

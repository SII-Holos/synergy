import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { domFixture } from "../support/dom-fixtures"

let server: ReturnType<typeof Bun.serve>
let browser: Browser
let page: Page
const errors: string[] = []

beforeAll(async () => {
  const directory = path.dirname(fileURLToPath(await domFixture("render-interactive.dom")))
  const styles = [...new Bun.Glob("*.css").scanSync({ cwd: directory })]
    .map((file) => `<link rel="stylesheet" href="/${file}">`)
    .join("")
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/")
        return new Response(
          `<!doctype html><head>${styles}<style>body { margin: 24px; font: 16px/1.5 sans-serif; } #root { max-width: 760px; margin: auto; } </style></head><body><div id="root"></div><script>globalThis.process = { env: { NODE_ENV: "test" } }</script><script type="module" src="/render-interactive.dom.js"></script></body>`,
          { headers: { "content-type": "text/html" } },
        )
      return new Response(Bun.file(path.join(directory, pathname)))
    },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error(error.stack)
  })
  await page.goto(server.url.href, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.waitForFunction(() => !!(window as unknown as { __renderTest: unknown }).__renderTest)
}, 120000)

afterAll(async () => {
  await browser?.close()
  server?.stop(true)
})

const lab = `<h2>Worker timing</h2><div id="a"><output id="total">84</output><span> seconds</span><svg role="img" aria-label="Task timing" width="100%" height="60"><rect id="bar" x="0" y="8" width="100%" height="32" fill="var(--render-chart-series-1)"/></svg></div><div id="b"><p>Second variant</p></div><input id="notes" aria-label="Notes"/><script>
(async () => {
 const api = synergy.render; await api.ready;
 api.variants([{id:'a',label:'Timing',element:document.getElementById('a')},{id:'b',label:'Details',element:document.getElementById('b')}]);
 api.controls([{id:'workers',label:'Workers',type:'number',value:1,min:1,max:8,step:1}], (values) => { document.getElementById('total').textContent=String(36+48/values.workers); });
 api.annotate(document.getElementById('bar'),{id:'bar',label:'Task duration'});
 document.body.dataset.ready='true';
})()
</script>`
async function setup(html = lab, libraries: string[] = []) {
  const version = await page.evaluate(
    ({ html, libraries }) =>
      (window as unknown as { __renderTest: { setup(html: string, libraries: string[]): string } }).__renderTest.setup(
        html,
        libraries,
      ),
    { html, libraries },
  )
  await page
    .frameLocator('[data-component="render-tool"] iframe')
    .locator(`html[data-render-version="${version}"] body[data-ready=true]`)
    .waitFor({ timeout: 15000 })
}
const inline = () => page.frameLocator('[data-component="render-tool"] iframe').first()

test("interactive source runs in an opaque frame and preserves parameters through the shared viewer", async () => {
  await setup()
  expect(await page.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts")
  await inline().getByRole("slider", { name: "Workers" }).fill("4")
  await inline().getByRole("slider", { name: "Workers" }).dispatchEvent("change")
  expect(await inline().locator("#total").innerText()).toBe("48")
  await inline().getByRole("textbox", { name: "Notes" }).fill("Keep this draft")
  await page.getByRole("button", { name: "Expand visual" }).click()
  const expanded = page.frameLocator('[data-component="render-viewer"] iframe')
  await expanded.locator("body[data-ready=true]").waitFor()
  expect(await expanded.locator("#total").innerText()).toBe("48")
  expect(await expanded.getByRole("textbox", { name: "Notes" }).inputValue()).toBe("Keep this draft")
  await expanded.getByRole("slider", { name: "Workers" }).fill("8")
  await expanded.getByRole("slider", { name: "Workers" }).dispatchEvent("change")
  await page.waitForFunction(
    () =>
      (window as unknown as { __renderTest: { stats(): { state: { revision: number } } } }).__renderTest.stats().state
        .revision >= 2,
  )
  await inline().locator("#total").filter({ hasText: "42" }).waitFor()
  await page.locator('[data-component="render-viewer"]').getByRole("button", { name: "Close dialog" }).click()
  expect(await inline().locator("#total").innerText()).toBe("42")
  const counts = await page.evaluate(() =>
    (window as unknown as { __renderTest: { stats(): { reads: number; writes: number } } }).__renderTest.stats(),
  )
  expect(counts.reads).toBeLessThanOrEqual(2)
  expect(counts.writes).toBeGreaterThan(0)
})

test("variants retain DOM values and feedback contains structural source identity", async () => {
  await setup()
  await inline().getByRole("button", { name: "Details", exact: true }).click()
  expect(await inline().locator("#a").isVisible()).toBe(false)
  await inline().getByRole("button", { name: "Timing", exact: true }).click()
  await inline().getByRole("slider", { name: "Workers" }).fill("4")
  await inline().getByRole("button", { name: "Review changes" }).click()
  await page.getByRole("button", { name: "Select an element for feedback" }).click()
  await inline().locator("#bar").click()
  await page.waitForFunction(
    () =>
      (window as unknown as { __renderTest: { stats(): { requests: string[] } } }).__renderTest.stats().requests
        .length >= 2,
  )
  const requests = await page.evaluate(
    () => (window as unknown as { __renderTest: { stats(): { requests: string[] } } }).__renderTest.stats().requests,
  )
  expect(requests.at(-1)).toContain('"id":"bar"')
  expect(requests.at(-1)).toContain('"screenshot":"unavailable"')
  expect(requests.at(-2)).toContain('"after":{"workers":4}')
  await page.getByRole("button", { name: "Finish selecting" }).click()
})

test("opaque scripts cannot access the parent, fetch APIs, or send unvalidated bridge messages", async () => {
  await setup(
    `<p id="security"></p><script>(async()=>{await synergy.render.ready;let parentDenied=false,fetchDenied=false;try{parent.document.body.dataset.compromised='true'}catch{parentDenied=true}try{await fetch('https://render-invalid.example/api')}catch{fetchDenied=true}document.getElementById('security').textContent=JSON.stringify({parentDenied,fetchDenied});parent.postMessage({type:'state',content:{modelContent:'forged'}},'*');document.body.dataset.ready='true'})()</script>`,
  )
  expect(JSON.parse(await inline().locator("#security").innerText())).toEqual({ parentDenied: true, fetchDenied: true })
  expect(await page.locator("body").getAttribute("data-compromised")).toBeNull()
})

test("HTTPS resources and bundled libraries load while the frame retains its host isolation", async () => {
  await page.route("https://unlisted-render.example/**", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.externalLibrary = 7;" }),
  )
  await setup(
    `<script src="https://unlisted-render.example/library.js"></script><p id="libraries"></p><script>(async()=>{await synergy.render.ready;document.getElementById('libraries').textContent=JSON.stringify({external:window.externalLibrary,d3:typeof d3.select,chart:typeof Chart,mermaid:typeof mermaid.render});document.body.dataset.ready='true'})()</script>`,
    ["d3", "chart", "mermaid"],
  )
  expect(JSON.parse(await inline().locator("#libraries").innerText())).toEqual({
    external: 7,
    d3: "function",
    chart: "function",
    mermaid: "function",
  })
  await page.unroute("https://unlisted-render.example/**")
}, 120000)

test("narrow layouts and live theme changes keep controls within the viewport", async () => {
  await setup()
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    const overflow = await inline()
      .locator("body")
      .evaluate((body) => body.scrollWidth > body.clientWidth + 1)
    expect(overflow).toBe(false)
  }
  await page.evaluate(() => {
    document.documentElement.dataset.colorScheme = "dark"
    document.documentElement.style.setProperty("--chart-series-1", "rgb(255, 0, 128)")
    document.dispatchEvent(new CustomEvent("synergy:theme-change"))
  })
  expect(
    await inline()
      .locator("#bar")
      .evaluate((bar) => getComputedStyle(bar).fill),
  ).toBe("rgb(255, 0, 128)")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await inline().locator("html[data-render-reduced-motion=true]").waitFor()
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

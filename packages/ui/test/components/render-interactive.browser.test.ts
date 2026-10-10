import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import type { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
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
  await expanded.getByRole("textbox", { name: "Notes" }).fill("Last edit before closing")
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
  expect(await inline().getByRole("textbox", { name: "Notes" }).inputValue()).toBe("Last edit before closing")
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
  expect(requests.at(-1)).toContain('"screenshot":"attached"')
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

test("Canvas feedback carries a bounded PNG and a blocked capture retains structural feedback", async () => {
  for (const unavailable of [false, true]) {
    await setup(
      `<canvas id="scene" width="160" height="80" aria-label="Canvas scene"></canvas><script>(async()=>{await synergy.render.ready;const canvas=document.getElementById('scene');canvas.getContext('2d').fillRect(8,8,80,40);synergy.render.annotate(canvas,{id:'scene',label:'Canvas scene',hitTest:()=>({id:'bar-1',label:'First bar'})});${unavailable ? "HTMLCanvasElement.prototype.toDataURL=()=>{throw new DOMException('Tainted canvas','SecurityError')}" : ""};document.body.dataset.ready='true'})()</script>`,
    )
    await page.getByRole("button", { name: "Select an element for feedback" }).click()
    const before = await page.evaluate(
      () =>
        (window as unknown as { __renderTest: { stats(): { requests: string[] } } }).__renderTest.stats().requests
          .length,
    )
    await inline().locator("#scene").click()
    await page.waitForFunction(
      (before) =>
        (window as unknown as { __renderTest: { stats(): { requests: string[] } } }).__renderTest.stats().requests
          .length > before,
      before,
    )
    const last = await page.evaluate(() =>
      (
        window as unknown as { __renderTest: { stats(): { requests: string[]; images: Array<string | undefined> } } }
      ).__renderTest.stats(),
    )
    expect(last.requests.at(-1)).toContain('"id":"bar-1"')
    expect(last.requests.at(-1)).toContain(`"screenshot":"${unavailable ? "unavailable" : "attached"}"`)
    if (unavailable) expect(last.images.at(-1)).toBeUndefined()
    else expect(last.images.at(-1)?.startsWith("data:image/png;base64,")).toBe(true)
    await page.getByRole("button", { name: "Finish selecting" }).click()
  }
})

test("export flushes unsaved parameters and remains interactive without host actions", async () => {
  await setup()
  await inline().getByRole("slider", { name: "Workers" }).fill("8")
  const downloaded = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export interactive HTML" }).click()
  const file = await downloaded
  const local = await file.path()
  expect(local).toBeTruthy()
  const directory = await mkdtemp(path.join(tmpdir(), "render-export-"))
  await Bun.write(path.join(directory, "visual.html"), Bun.file(local!))
  const exported = await browser.newPage()
  try {
    await exported.goto(`file://${directory}/visual.html`)
    await exported.locator("body[data-ready=true]").waitFor()
    expect(await exported.locator("#total").innerText()).toBe("42")
    await exported.getByRole("slider", { name: "Workers" }).fill("4")
    expect(await exported.locator("#total").innerText()).toBe("48")
    expect(await exported.getByRole("button", { name: "Review changes" }).isDisabled()).toBe(true)
  } finally {
    await exported.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test("calendar rejects normalized invalid dates and restores its selected month", async () => {
  await setup(
    `<div id="calendar"></div><output id="invalid"></output><script>(async()=>{const api=synergy.render;await api.ready;try{api.calendar(document.getElementById('calendar'),{events:[{id:'invalid',title:'Invalid',start:'2026-02-31'}]})}catch{document.getElementById('invalid').textContent='rejected'}api.calendar(document.getElementById('calendar'),{events:[{id:'leap',title:'Leap day',start:'2024-02-29'}]});document.body.dataset.ready='true'})()</script>`,
  )
  expect(await inline().locator("#invalid").innerText()).toBe("rejected")
  await inline().getByRole("button", { name: "Next month" }).click()
  await page.getByRole("button", { name: "Expand visual" }).click()
  const expanded = page.frameLocator('[data-component="render-viewer"] iframe')
  await expanded.locator("body[data-ready=true]").waitFor()
  expect(await expanded.locator("#calendar strong").innerText()).toContain("March")
  await page.locator('[data-component="render-viewer"]').getByRole("button", { name: "Close dialog" }).click()
})

test("inactive inline frames pause animation work and resume without remounting", async () => {
  await setup(
    `<output id="ticks">0</output><script>(async()=>{await synergy.render.ready;let ticks=0;function tick(){document.getElementById('ticks').textContent=String(++ticks);requestAnimationFrame(tick)}requestAnimationFrame(tick);document.body.dataset.ready='true'})()</script>`,
  )
  await page.getByRole("button", { name: "Expand visual" }).click()
  await inline().locator("html[data-render-active=false]").waitFor()
  const paused = await inline().locator("#ticks").innerText()
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
  expect(await inline().locator("#ticks").innerText()).toBe(paused)
  await page.locator('[data-component="render-viewer"]').getByRole("button", { name: "Close dialog" }).click()
  await inline().locator("html[data-render-active=true]").waitFor()
  await inline()
    .locator("#ticks")
    .evaluate(
      (element, paused) =>
        new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            if (Number(element.textContent) > Number(paused)) {
              observer.disconnect()
              resolve()
            }
          })
          observer.observe(element, { childList: true })
        }),
      paused,
    )
})

test("live locale and font changes retain the mounted interactive document", async () => {
  await setup()
  await inline().getByRole("slider", { name: "Workers" }).fill("4")
  await page.evaluate(() =>
    (window as unknown as { __renderTest: { locale(locale: string): void } }).__renderTest.locale("zh-CN"),
  )
  await inline().locator("html[lang=zh-CN]").waitFor()
  expect(await inline().getByRole("button", { name: "重置", exact: true }).count()).toBe(1)
  expect(await inline().locator("#total").innerText()).toBe("48")
  expect(
    await inline()
      .locator("body")
      .evaluate(async () => {
        await document.fonts.ready
        return Array.from(document.fonts).some((font) => font.family === "Inter" && font.status === "loaded")
      }),
  ).toBe(true)
  await page.evaluate(() =>
    (window as unknown as { __renderTest: { locale(locale: string): void } }).__renderTest.locale("en"),
  )
})

test("a remote reset to an earlier local value is not mistaken for a write echo", async () => {
  await setup()
  type Host = {
    __renderTest: { stats(): { state: RenderArtifact.State }; remote(content: RenderArtifact.Content): void }
  }
  for (const value of [4, 8]) {
    await inline().getByRole("slider", { name: "Workers" }).fill(String(value))
    await inline().getByRole("slider", { name: "Workers" }).dispatchEvent("change")
    await page.waitForFunction(
      (value) =>
        JSON.stringify((window as unknown as Host).__renderTest.stats().state.content).includes(`"*:workers":${value}`),
      value,
    )
    if (value === 4)
      await page.evaluate(() => {
        sessionStorage.setItem(
          "saved-render-content",
          JSON.stringify((window as unknown as Host).__renderTest.stats().state.content),
        )
      })
  }
  await page.evaluate(() =>
    (window as unknown as Host).__renderTest.remote(JSON.parse(sessionStorage.getItem("saved-render-content")!)),
  )
  await inline().locator("#total").filter({ hasText: "48" }).waitFor({ timeout: 2000 })
})

test("control definitions reject out-of-range defaults and duplicate choices", async () => {
  await setup(
    `<output id="invalid"></output><script>(async()=>{const api=synergy.render;await api.ready;let rejected=0;for(const control of [{id:'count',label:'Count',type:'number',min:1,max:8,value:9},{id:'choice',label:'Choice',type:'select',value:'A',options:['A','A']}]){try{api.controls([control],()=>{})}catch{rejected++}}document.getElementById('invalid').textContent=String(rejected);document.body.dataset.ready='true'})()</script>`,
  )
  expect(await inline().locator("#invalid").innerText()).toBe("2")
})

test("human review remains pending past the state-save timeout", async () => {
  await setup(
    `<button id="review">Review</button><output id="status">idle</output><script>(async()=>{await synergy.render.ready;document.getElementById('review').onclick=async()=>{const status=document.getElementById('status');status.textContent='waiting';try{await synergy.render.requestFollowUp('Review this timing');status.textContent='settled'}catch{status.textContent='failed'}};document.body.dataset.ready='true'})()</script>`,
  )
  await page.evaluate(() =>
    (window as unknown as { __renderTest: { holdFollowUp(): void } }).__renderTest.holdFollowUp(),
  )
  await page.clock.install()
  try {
    await inline().locator("#review").click()
    await page.clock.fastForward(31000)
    expect(await inline().locator("#status").innerText()).toBe("waiting")
  } finally {
    await page.evaluate(() =>
      (window as unknown as { __renderTest: { releaseFollowUp(): void } }).__renderTest.releaseFollowUp(),
    )
    await page.clock.resume()
  }
})

test("restoring semantic state redraws controls without writing the same state again", async () => {
  await page.reload()
  await page.waitForFunction(() => !!(window as unknown as { __renderTest: unknown }).__renderTest)
  await setup(
    lab.replace(
      "String(36+48/values.workers);",
      "String(36+48/values.workers); api.setState({modelContent:{workers:values.workers}}).catch(()=>{});",
    ),
  )
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))
  const before = await page.evaluate(() => {
    const host = (
      window as unknown as { __renderTest: { stats(): { writes: number }; remote(content: unknown): void } }
    ).__renderTest
    const writes = host.stats().writes
    host.remote({
      modelContent: { workers: 8 },
      uiContent: { renderViewVersion: 1, view: { controls: { "*:workers": 8 }, variant: "a" } },
    })
    return writes
  })
  await inline().locator("#total").filter({ hasText: "42" }).waitFor()
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))
  const writes = await page.evaluate(
    () => (window as unknown as { __renderTest: { stats(): { writes: number } } }).__renderTest.stats().writes,
  )
  expect(writes).toBe(before)
})

test("asynchronous authored state saves settle across expansion and variant restoration", async () => {
  await setup(`<div id="a" style="min-height:600px"><output id="total"></output></div><div id="b">Assumptions</div><script>
  (async()=>{const api=synergy.render;await api.ready;let workers=api.getState().modelContent?.workers??4;
  const draw=()=>document.getElementById('total').textContent=String(36+48/workers);
  api.controls([{id:'workers',label:'Workers',type:'number',value:workers,min:1,max:8,step:1}],values=>{
    if(values.workers===workers)return;workers=values.workers;draw();Promise.resolve().then(()=>api.setState({modelContent:{workers}})).catch(error=>document.body.dataset.saveError=error.message)
  });
  api.variants([{id:'a',label:'Timing',element:document.getElementById('a')},{id:'b',label:'Details',element:document.getElementById('b')}]);
  api.addEventListener('statechange',()=>Promise.resolve().then(()=>{workers=api.getState().modelContent?.workers??workers;draw()}));draw();document.body.dataset.ready='true';})()
  </script>`)
  await inline().getByRole("slider", { name: "Workers" }).fill("8")
  await page.getByRole("button", { name: "Expand visual" }).click()
  const expanded = page.frameLocator('[data-component="render-viewer"] iframe')
  await expanded.locator("body[data-ready=true]").waitFor()
  await expanded.getByRole("slider", { name: "Workers" }).fill("1")
  await expanded.getByRole("button", { name: "Details", exact: true }).click()
  await page.locator('[data-component="render-viewer"]').getByRole("button", { name: "Close dialog" }).click()
  await page.locator('[data-component="render-viewer"]').waitFor({ state: "detached" })
  await page.getByRole("button", { name: "Expand visual" }).click()
  await expanded.locator("body[data-ready=true]").waitFor()
  expect(await expanded.getByRole("slider", { name: "Workers" }).inputValue()).toBe("1")
  expect(await page.getByRole("alert").count()).toBe(0)
  await page.locator('[data-component="render-viewer"]').getByRole("button", { name: "Close dialog" }).click()
})

test("failed close saves keep the viewer open until the user discards", async () => {
  await setup()
  await page.getByRole("button", { name: "Expand visual" }).click()
  const expanded = page.frameLocator('[data-component="render-viewer"] iframe')
  await expanded.locator("body[data-ready=true]").waitFor()
  await page.evaluate(() =>
    (window as unknown as { __renderTest: { rejectWrites(): void } }).__renderTest.rejectWrites(),
  )
  await expanded.getByRole("slider", { name: "Workers" }).fill("8")
  const viewer = page.locator('[data-component="render-viewer"]')
  await viewer.getByRole("button", { name: "Close dialog" }).click()
  await viewer.getByRole("button", { name: "Close without saving" }).waitFor()
  expect(await viewer.getByRole("dialog").isVisible()).toBe(true)
  expect(await viewer.getByRole("alert").first().innerText()).toContain("Saving is unavailable")
  await viewer.getByRole("button", { name: "Close without saving" }).click()
  await viewer.waitFor({ state: "detached" })
})

test("the initial bridge handshake adopts a state update received before the frame is ready", async () => {
  await page.evaluate(() => {
    function update(event: MessageEvent) {
      if (event.data?.type !== "synergy.render.ready") return
      window.removeEventListener("message", update, true)
      ;(window as unknown as { __renderTest: { remote(content: unknown): void } }).__renderTest.remote({
        modelContent: { workers: 8 },
      })
    }
    window.addEventListener("message", update, true)
  })
  await setup(
    `<output id="workers"></output><script>(async()=>{await synergy.render.ready;document.getElementById('workers').textContent=String(synergy.render.getState().modelContent?.workers??4);document.body.dataset.ready='true'})()</script>`,
  )
  expect(await inline().locator("#workers").innerText()).toBe("8")
})

test("form restoration preserves named radio groups without explicit element IDs", async () => {
  await setup(
    `<label><input type="radio" name="mode" value="fast">Fast</label><label><input type="radio" name="mode" value="slow">Slow</label><script>synergy.render.ready.then(()=>document.body.dataset.ready='true')</script>`,
  )
  await inline().getByRole("radio", { name: "Fast", exact: true }).check()
  await page.getByRole("button", { name: "Expand visual" }).click()
  const expanded = page.frameLocator('[data-component="render-viewer"] iframe')
  await expanded.locator("body[data-ready=true]").waitFor()
  expect(await expanded.getByRole("radio", { name: "Fast", exact: true }).isChecked()).toBe(true)
  expect(await expanded.getByRole("radio", { name: "Slow", exact: true }).isChecked()).toBe(false)
  await page.locator('[data-component="render-viewer"]').getByRole("button", { name: "Close dialog" }).click()
  await page.locator('[data-component="render-viewer"]').waitFor({ state: "detached" })
})

test("deferred browser resize notifications do not hide a working visual or suppress authored errors", async () => {
  await setup(
    `<button id="notice">Resize notification</button><button id="error">Authored error</button><script>synergy.render.ready.then(()=>{const message='ResizeObserver loop completed with undelivered notifications.';document.getElementById('notice').onclick=()=>window.dispatchEvent(new ErrorEvent('error',{message}));document.getElementById('error').onclick=()=>window.dispatchEvent(new ErrorEvent('error',{message,error:new Error(message)}));document.body.dataset.ready='true'})</script>`,
  )
  await inline().getByRole("button", { name: "Resize notification" }).click()
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(await page.getByRole("alert").count()).toBe(0)
  await inline().getByRole("button", { name: "Authored error" }).click()
  await page.getByRole("alert").filter({ hasText: "ResizeObserver loop completed" }).waitFor()
})

const estimate = {
  state: { seats: 8 },
  computed: [{ id: "price", op: "multiply", inputs: [{ ref: "seats" }, 29] }],
  nodes: [
    { id: "heading", type: "heading", text: "Team estimate" },
    { id: "seats", type: "slider", label: "Seats", state: "seats", min: 1, max: 50 },
    { id: "price", type: "metric", label: "Monthly price", value: { ref: "price" }, prefix: "$" },
    { id: "next", type: "button", label: "Discuss estimate", text: "Review this estimate" },
  ],
}
async function native(ui: unknown = estimate, streaming = false) {
  await page.evaluate(
    ({ ui, streaming }) =>
      (window as unknown as { __renderTest: { setupUI(ui: unknown, streaming: boolean): void } }).__renderTest.setupUI(
        ui,
        streaming,
      ),
    { ui, streaming },
  )
  await page.getByRole("heading", { name: "Team estimate" }).waitFor()
}
async function stream(ui: unknown, complete = false) {
  await page.evaluate(
    ({ ui, complete }) =>
      (window as unknown as { __renderTest: { stream(ui: unknown, complete: boolean): void } }).__renderTest.stream(
        ui,
        complete,
      ),
    { ui, complete },
  )
}
test("native catalog streams locally, retains focused controls and promotes preview state on completion", async () => {
  await native({ ...estimate, nodes: estimate.nodes.slice(0, 3) }, true)
  expect(await page.locator("iframe").count()).toBe(0)
  const slider = page.getByRole("slider", { name: "Seats" })
  await slider.fill("9")
  await slider.focus()
  const before = await page.evaluate(
    () => (window as unknown as { __renderTest: { stats(): { writes: number } } }).__renderTest.stats().writes,
  )
  await stream({ ...estimate, nodes: [...estimate.nodes, { id: "partial", type: "metric" }] })
  expect(await slider.inputValue()).toBe("9")
  expect(await slider.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.getByText("$261", { exact: true }).waitFor()
  expect(
    await page.evaluate(
      () => (window as unknown as { __renderTest: { stats(): { writes: number } } }).__renderTest.stats().writes,
    ),
  ).toBe(before)
  await page.evaluate(() => (window as unknown as { __renderTest: { prepare(): void } }).__renderTest.prepare())
  expect(await slider.inputValue()).toBe("9")
  await stream(estimate, true)
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __renderTest: { stats(): { state: { content: { modelContent: { parameters: { seats: number } } } } } }
        }
      ).__renderTest.stats().state.content.modelContent?.parameters?.seats === 9,
  )
  await page.getByRole("button", { name: "Expand visual" }).click()
  const expanded = page.locator('[data-component="render-viewer"]')
  expect(await expanded.getByRole("slider", { name: "Seats" }).inputValue()).toBe("9")
  await expanded.getByRole("slider", { name: "Seats" }).fill("10")
  await expanded.getByRole("button", { name: "Close dialog" }).click()
  expect(await slider.inputValue()).toBe("10")
})
test("native preview promotion keeps failed saves recoverable before expanding", async () => {
  await native(estimate, true)
  await page.getByRole("slider", { name: "Seats" }).fill("9")
  await page.evaluate(() =>
    (window as unknown as { __renderTest: { rejectWrites(): void } }).__renderTest.rejectWrites(),
  )
  await stream(estimate, true)
  await page.getByRole("alert").getByText("Saving is unavailable", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Expand visual" }).click()
  expect(await page.locator('[data-component="render-viewer"]').count()).toBe(0)
  expect(await page.getByRole("slider", { name: "Seats" }).inputValue()).toBe("9")
  await page.evaluate(() => (window as unknown as { __renderTest: { retryWrites(): void } }).__renderTest.retryWrites())
  await page.getByRole("button", { name: "Expand visual" }).click()
  const viewer = page.locator('[data-component="render-viewer"]')
  expect(await viewer.getByRole("slider", { name: "Seats" }).inputValue()).toBe("9")
  await viewer.getByRole("button", { name: "Close dialog" }).click()
})
test("native catalog keeps its last good view on arithmetic failure and previews follow-ups", async () => {
  await native(estimate, true)
  await stream({ ...estimate, computed: [{ id: "price", op: "divide", inputs: [1, 0] }] })
  await page.getByRole("alert").filter({ hasText: "price" }).waitFor()
  expect(await page.getByText("$232", { exact: true }).count()).toBe(1)
  await stream(estimate, true)
  await page.getByRole("button", { name: "Discuss estimate" }).click()
  const requests = await page.evaluate(
    () => (window as unknown as { __renderTest: { stats(): { requests: string[] } } }).__renderTest.stats().requests,
  )
  expect(requests.at(-1)).toContain('"seats":8')
  await page.setViewportSize({ width: 375, height: 800 })
  expect(
    await page
      .locator('[data-component="render-native"]')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true)
  await page.setViewportSize({ width: 1000, height: 900 })
})

test("native state adopts conflicts and standalone exports retain controls without host authority", async () => {
  await native()
  await page.evaluate(() =>
    (window as unknown as { __renderTest: { conflictWrites(): void } }).__renderTest.conflictWrites(),
  )
  const slider = page.getByRole("slider", { name: "Seats" })
  await slider.fill("11")
  await page.getByRole("alert").filter({ hasText: "Another view" }).waitFor()
  expect(await slider.inputValue()).toBe("12")
  await slider.fill("13")
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export interactive HTML" }).click(),
  ])
  const file = await download.path()
  const document = await Bun.file(file!).text()
  const exported = await browser.newPage()
  try {
    await exported.setContent(document)
    await exported.getByText("$377", { exact: true }).waitFor()
    await exported.getByRole("slider", { name: "Seats" }).fill("14")
    expect(await exported.getByText("$406", { exact: true }).count()).toBe(1)
    expect(await exported.getByRole("button", { name: "Discuss estimate" }).isDisabled()).toBe(true)
  } finally {
    await exported.close()
  }
})

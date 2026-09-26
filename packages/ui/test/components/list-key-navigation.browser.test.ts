import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { build, normalizePath } from "vite"
import solid from "vite-plugin-solid"

type FixtureWindow = typeof window & {
  listKeyFixture: {
    setKey(key: string): void
    selectTarget(): void
    selectFirst(): void
    unmount(): void
  }
}

let fixture: string
let server: ReturnType<typeof Bun.serve>
let browser: Browser
let page: Page
let base: string
const errors: string[] = []
const networkErrors: string[] = []
const keys = [
  JSON.stringify(["operation", "part-2", JSON.stringify(["workspace", 2, "/root", "same.txt"])]),
  'C:\\中文\\a"b.txt',
  'row"], [data-key="row-0',
  "line\nbreak\t🙂'[]",
  "",
]

beforeAll(async () => {
  const cache = path.resolve(import.meta.dir, "../../node_modules/.cache")
  await mkdir(cache, { recursive: true })
  fixture = await mkdtemp(path.join(cache, "list-key-navigation-"))
  const source = normalizePath(path.resolve(import.meta.dir, "../../src/components/list.tsx"))
  await Bun.write(
    path.join(fixture, "index.html"),
    `<style>[data-slot="list-scroll"]{height:100px;width:320px;overflow:auto}[data-slot="list-item"]{display:block;width:100%;height:40px;flex-shrink:0}</style><div id="root"></div><script type="module" src="/main.tsx"></script>`,
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal,Show} from "solid-js"
    import {I18nProvider} from "@lingui/solid"
    import {setupI18n} from "@lingui/core"
    import {List} from ${JSON.stringify(`/@fs/${source}`)}
    const [key,setKey]=createSignal("target")
    const [current,setCurrent]=createSignal()
    const [selected,setSelected]=createSignal()
    const [mounted,setMounted]=createSignal(true)
    const first={id:"row-0",label:"First"}
    const target=()=>({id:key(),label:"Target"})
    const items=()=>[first,...Array.from({length:7},(_,i)=>({id:"row-"+(i+1),label:"Row "+(i+1)})),target(),{id:"last",label:"Last"}]
    window.listKeyFixture={setKey,selectTarget:()=>setCurrent(target()),selectFirst:()=>setCurrent(first),unmount:()=>setMounted(false)}
    const i18n=setupI18n({locale:"en",messages:{en:{}}})
    render(()=><I18nProvider i18n={i18n}><Show when={mounted()}><List items={items()} key={item=>item.id} current={current()} search={{placeholder:"Find item"}} onSelect={setSelected}>{item=>item.label}</List></Show><output data-testid="selection">{selected()?.label}</output></I18nProvider>,document.getElementById("root"))
    `,
  )
  await build({
    configFile: false,
    root: fixture,
    plugins: [solid()],
    logLevel: "error",
    build: { outDir: "dist", target: "esnext", minify: false },
  })
  const assets = new Map<string, ReturnType<typeof Bun.file>>()
  for await (const file of new Bun.Glob("**/*").scan(path.join(fixture, "dist"))) {
    assets.set("/" + file, Bun.file(path.join(fixture, "dist", file)))
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      const file = assets.get(pathname === "/" ? "/index.html" : pathname)
      return file ? new Response(file) : new Response("Not found", { status: 404 })
    },
  })
  base = server.url.toString()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && networkErrors.length < 10) networkErrors.push(message.text())
  })
  page.on("requestfailed", (request) => {
    if (networkErrors.length < 10) networkErrors.push(`${request.url()}: ${request.failure()?.errorText}`)
  })
}, 60_000)

beforeEach(async () => {
  errors.length = 0
  networkErrors.length = 0
  await page.goto(base)
  await page
    .getByRole("button", { name: "Target", exact: true })
    .waitFor()
    .catch(async (error) => {
      throw new Error(JSON.stringify({ errors, networkErrors, html: await page.locator("#root").innerHTML() }), {
        cause: error,
      })
    })
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop(true)
  if (fixture) await rm(fixture, { recursive: true, force: true })
}, 30_000)

async function settleFrames() {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}

async function expectTargetVisible() {
  await page.waitForFunction(() => {
    const scroll = document.querySelector('[data-slot="list-scroll"]')!
    const target = [...scroll.querySelectorAll('[data-slot="list-item"]')].find(
      (item) => item.textContent === "Target",
    )!
    const outer = scroll.getBoundingClientRect()
    const inner = target.getBoundingClientRect()
    return inner.top >= outer.top && inner.bottom <= outer.bottom
  })
}

test.each(keys)("current selection scrolls to the exact arbitrary key %j", async (key) => {
  await page.evaluate((value) => (window as FixtureWindow).listKeyFixture.setKey(value), key)
  await page.evaluate(() => (window as FixtureWindow).listKeyFixture.selectTarget())
  await settleFrames()
  expect(errors).toEqual([])
  await expectTargetVisible()
})

test.each(keys)("keyboard navigation scrolls and selects the exact arbitrary key %j", async (key) => {
  await page.evaluate((value) => (window as FixtureWindow).listKeyFixture.setKey(value), key)
  const input = page.getByPlaceholder("Find item")
  for (let i = 0; i < 8; i++) await input.press("ArrowDown")
  await settleFrames()
  expect(errors).toEqual([])
  expect(await page.locator('[data-active="true"]').getAttribute("data-key")).toBe(key)
  await expectTargetVisible()
  await input.press("Enter")
  expect(await page.getByTestId("selection").textContent()).toBe("Target")
})

test("disposing the list cancels a pending current-selection scroll", async () => {
  await page.evaluate((key) => {
    const fixture = (window as FixtureWindow).listKeyFixture
    fixture.setKey(key)
    fixture.selectTarget()
    fixture.unmount()
  }, keys[0]!)
  await settleFrames()
  expect(await page.locator('[data-component="list"]').count()).toBe(0)
  expect(errors).toEqual([])
})

test("a newer selection supersedes the pending scroll", async () => {
  await page.evaluate((key) => {
    const fixture = (window as FixtureWindow).listKeyFixture
    fixture.setKey(key)
    fixture.selectTarget()
    fixture.selectFirst()
  }, keys[0]!)
  await settleFrames()
  expect(errors).toEqual([])
  expect(await page.locator('[data-slot="list-scroll"]').evaluate((element) => element.scrollTop)).toBe(0)
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { build, normalizePath } from "vite"
import solid from "vite-plugin-solid"

type FixtureWindow = typeof window & { selectCollectionKey(): void }
let fixture: string
let browser: Browser
let page: Page
let server: ReturnType<typeof Bun.serve>
const errors: string[] = []
const keys = [
  JSON.stringify(["operation", "part-2", JSON.stringify(["workspace", 2, "/root", "same.txt"])]),
  'C:\\中文\\a"b.txt',
  'row"], [data-key="row-0',
  "line\nbreak\t🙂'[]",
]
const cases = ["jsx", "js"].flatMap((entry) => keys.map((key) => ({ entry, key })))

beforeAll(async () => {
  const cache = path.resolve(import.meta.dir, "../../node_modules/.cache")
  await mkdir(cache, { recursive: true })
  fixture = await mkdtemp(path.join(cache, "collection-key-navigation-"))
  const component = (name: string) =>
    JSON.stringify(`/@fs/${normalizePath(path.resolve(import.meta.dir, `../../src/components/${name}.tsx`))}`)
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {createSignal,For,Show} from "solid-js"
    import {Accordion} from ${component("accordion")}
    import {Tabs} from ${component("tabs")}
    const params=new URLSearchParams(location.search)
    const key=params.get("key")
    const items=[{id:"row-0",label:"First"},{id:key,label:"Target"},{id:"row-last",label:"Last"}]
    const [open,setOpen]=createSignal([])
    const [selected,setSelected]=createSignal("row-0")
    const [changes,setChanges]=createSignal([])
    window.selectCollectionKey=()=>{setOpen([key]);setSelected(key)}
    const onChange=next=>{setOpen(next);setChanges(next)}
    render(()=><>
      <input aria-label="Outside" />
      <Show when={params.get("widget")==="accordion"} fallback={
        <Tabs value={selected()} onChange={setSelected}>
          <Tabs.List><For each={items}>{item=><Tabs.Trigger value={item.id}>{item.label}</Tabs.Trigger>}</For></Tabs.List>
          <For each={items}>{item=><Tabs.Content value={item.id}>{item.label} content</Tabs.Content>}</For>
        </Tabs>
      }>
        <Accordion multiple collapsible value={params.has("uncontrolled")?undefined:open()} defaultValue={params.has("uncontrolled")?[key]:undefined} onChange={onChange}>
          <For each={items}>{item=><Accordion.Item value={item.id}><Accordion.Header><Accordion.Trigger>{item.label}</Accordion.Trigger></Accordion.Header><Accordion.Content>{item.label} content<input aria-label={item.label+" editor"}/></Accordion.Content></Accordion.Item>}</For>
        </Accordion>
      </Show>
      <output data-testid="changes">{JSON.stringify(changes())}</output>
      <output data-testid="selected">{JSON.stringify(selected())}</output>
    </>,document.getElementById("root"))
  `,
  )
  const assets = new Map<string, ReturnType<typeof Bun.file>>()
  for (const entry of ["jsx", "js"]) {
    const dist = path.join(fixture, entry)
    const kobalte = normalizePath(path.resolve(import.meta.dir, "../../node_modules/@kobalte/core/dist"))
    await build({
      configFile: false,
      root: fixture,
      base: `/${entry}/`,
      plugins: [solid()],
      resolve:
        entry === "js"
          ? {
              alias: [
                { find: "@kobalte/core/accordion", replacement: `${kobalte}/accordion/index.js` },
                { find: "@kobalte/core/tabs", replacement: `${kobalte}/tabs/index.js` },
              ],
            }
          : undefined,
      logLevel: "error",
      build: { outDir: dist, target: "esnext", minify: false },
    })
    for await (const file of new Bun.Glob("**/*").scan(dist))
      assets.set(`/${entry}/${file}`, Bun.file(path.join(dist, file)))
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      const file = assets.get(pathname.endsWith("/") ? pathname + "index.html" : pathname)
      return file ? new Response(file) : new Response("Not found", { status: 404 })
    },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(4000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop(true)
  if (fixture) await rm(fixture, { recursive: true, force: true })
}, 30_000)

async function open(input: { entry: string; key: string }, widget: "accordion" | "tabs", uncontrolled = false) {
  errors.length = 0
  const url = new URL(`/${input.entry}/`, server.url)
  url.searchParams.set("widget", widget)
  url.searchParams.set("key", input.key)
  if (uncontrolled) url.searchParams.set("uncontrolled", "1")
  await page.goto(url.toString())
  await page.getByRole(widget === "accordion" ? "button" : "tab", { name: "Target", exact: true }).waitFor()
}

async function settle() {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  expect(errors).toEqual([])
}

test.each(cases)("accordion click preserves the opaque key %j", async (input) => {
  await open(input, "accordion")
  const target = page.getByRole("button", { name: "Target", exact: true })
  await target.click()
  await settle()
  expect(await target.getAttribute("aria-expanded")).toBe("true")
  expect(await page.getByTestId("changes").textContent()).toBe(JSON.stringify([input.key]))
  await target.click()
  await settle()
  expect(await target.getAttribute("aria-expanded")).toBe("false")
  expect(await page.getByTestId("changes").textContent()).toBe("[]")
})

test.each(cases)("accordion keyboard focus and controlled changes preserve the opaque key %j", async (input) => {
  await open(input, "accordion")
  await page.getByRole("button", { name: "First", exact: true }).press("ArrowDown")
  await settle()
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Target")
  await page.getByRole("button", { name: "Target", exact: true }).press("Enter")
  await settle()
  expect(await page.getByTestId("changes").textContent()).toBe(JSON.stringify([input.key]))
  await page.getByRole("button", { name: "First", exact: true }).click()
  await page.evaluate(() => (window as FixtureWindow).selectCollectionKey())
  await settle()
  expect(await page.getByRole("button", { name: "First", exact: true }).getAttribute("aria-expanded")).toBe("false")
  expect(await page.getByRole("button", { name: "Target", exact: true }).getAttribute("aria-expanded")).toBe("true")
})

test.each(cases)("accordion uncontrolled default remains interactive for the opaque key %j", async (input) => {
  await open(input, "accordion", true)
  const target = page.getByRole("button", { name: "Target", exact: true })
  expect(await target.getAttribute("aria-expanded")).toBe("true")
  await target.click()
  await settle()
  expect(await target.getAttribute("aria-expanded")).toBe("false")
})

test.each(cases)("tabs selection and keyboard navigation preserve the opaque key %j", async (input) => {
  await open(input, "tabs")
  await page.evaluate(() => (window as FixtureWindow).selectCollectionKey())
  await settle()
  expect(await page.getByRole("tab", { name: "Target", exact: true }).getAttribute("aria-selected")).toBe("true")
  await page.getByRole("tab", { name: "First", exact: true }).press("ArrowRight")
  await settle()
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Target")
  expect(await page.getByTestId("selected").textContent()).toBe(JSON.stringify(input.key))
})

test.each(cases)("accordion content keeps native focus after leaving the collection %j", async (input) => {
  await open(input, "accordion")
  await page.getByRole("button", { name: "Target", exact: true }).click()
  await page.getByLabel("Outside", { exact: true }).click()
  await page.getByLabel("Target editor", { exact: true }).click()
  await settle()
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Target editor")
})

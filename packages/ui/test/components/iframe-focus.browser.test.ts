import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { build, normalizePath } from "vite"
import solid from "vite-plugin-solid"

type FocusResult = { tabbable: string[]; active: string | null }
type FixtureWindow = typeof window & { inspectFocus(): FocusResult }
let fixture: string
let browser: Browser
let page: Page
let server: ReturnType<typeof Bun.serve>
let completeFrame: (() => void) | undefined
const errors: string[] = []

beforeAll(async () => {
  const cache = path.resolve(import.meta.dir, "../../node_modules/.cache")
  await mkdir(cache, { recursive: true })
  fixture = await mkdtemp(path.join(cache, "iframe-focus-"))
  const core = Bun.resolveSync("@kobalte/core", path.resolve(import.meta.dir, "../.."))
  const utils = normalizePath(Bun.resolveSync("@kobalte/utils", path.dirname(core)))
  await Bun.write(
    path.join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(fixture, "main.tsx"),
    `
    import {render} from "solid-js/web"
    import {getAllTabbableIn,getActiveElement} from ${JSON.stringify(utils)}
    render(()=><main id="container">
      <button id="before">Before</button>
      <iframe id="preview" title="Preview" src="/pending" />
      <button id="after">After</button>
    </main>,document.getElementById("root"))
    window.inspectFocus=()=>({
      tabbable:getAllTabbableIn(document.getElementById("container")).map(element=>element.id),
      active:getActiveElement(document.body)?.id??null,
    })
  `,
  )
  const dist = path.join(fixture, "dist")
  await build({
    configFile: false,
    root: fixture,
    plugins: [solid()],
    logLevel: "error",
    build: { outDir: dist, target: "esnext", minify: false },
  })
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/pending")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<html><head><title>Pending</title>"))
              completeFrame = () => {
                controller.enqueue(
                  new TextEncoder().encode('</head><body><button id="inside">Inside</button></body></html>'),
                )
                controller.close()
                completeFrame = undefined
              }
            },
            cancel() {
              completeFrame = undefined
            },
          }),
          { headers: { "content-type": "text/html" } },
        )
      const file = Bun.file(path.join(dist, pathname === "/" ? "index.html" : pathname.slice(1)))
      return new Response(file)
    },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 60_000)

afterAll(async () => {
  completeFrame?.()
  await browser?.close()
  await server?.stop(true)
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test("focus traversal keeps a loading same-origin iframe usable before and after its body arrives", async () => {
  await page.goto(server.url.toString(), { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe")
    return frame?.contentDocument?.title === "Pending" && !frame.contentDocument.body
  })
  await page.locator("iframe").focus()
  expect(await page.evaluate(() => (window as FixtureWindow).inspectFocus())).toEqual({
    tabbable: ["before", "preview", "after"],
    active: "preview",
  })
  completeFrame?.()
  await page.frameLocator("iframe").getByRole("button", { name: "Inside" }).click()
  expect(await page.evaluate(() => (window as FixtureWindow).inspectFocus())).toEqual({
    tabbable: ["before", "inside", "after"],
    active: "inside",
  })
  await page.getByRole("button", { name: "Before" }).press("Tab")
  expect(await page.evaluate(() => (window as FixtureWindow).inspectFocus().active)).toBe("inside")
  await page.frameLocator("iframe").getByRole("button", { name: "Inside" }).press("Tab")
  expect(await page.evaluate(() => (window as FixtureWindow).inspectFocus().active)).toBe("after")
  expect(errors).toEqual([])
}, 15_000)

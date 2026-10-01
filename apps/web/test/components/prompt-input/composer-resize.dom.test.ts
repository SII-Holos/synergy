import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

let browser: Browser
let page: Page
let server: ViteDevServer
let cache: string
const errors: string[] = []
beforeAll(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "composer-reader-test-"))
  const root = path.resolve(import.meta.dir, "../../fixtures/plugin-ui5")
  server = await createServer({
    cacheDir: cache,
    configFile: false,
    root,
    plugins: [
      solidPlugin(),
      tailwind(),
      {
        name: "resize-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/") return next()
            res.setHeader("Content-Type", "text/html")
            res.end(
              '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/composer-resize.tsx"></script>',
            )
          })
        },
      },
    ],
    resolve: { alias: { "@": path.resolve(import.meta.dir, "../../../src") } },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/composer-resize.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls!.local[0]!, { timeout: 30_000 })
  expect(errors).toEqual([])
  await page.getByRole("separator", { name: "Resize editor" }).waitFor()
}, 90_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (cache) await rm(cache, { recursive: true, force: true })
})

test("pointer cancellation restores height and release crosses the expansion threshold", async () => {
  const handle = page.getByRole("separator", { name: "Resize editor" })
  const rect = await handle.boundingBox()
  const x = rect!.x + rect!.width / 2,
    y = rect!.y + rect!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 200, { steps: 5 })
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(
    Number(await handle.getAttribute("aria-valuemax")),
  )
  await page.keyboard.press("Escape")
  await page.mouse.up()
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(96)
  const next = await handle.boundingBox()
  await page.mouse.move(next!.x + next!.width / 2, next!.y + next!.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, next!.y - 260, { steps: 5 })
  expect(await page.locator(".composer-resize-cue").textContent()).toBe("Release to expand")
  await page.mouse.up()
  expect(await page.locator("#expanded").textContent()).toBe("true")
})

test("keyboard resizing and the corner button replace the size menu", async () => {
  await page.reload()
  const handle = page.getByRole("separator", { name: "Resize editor" })
  await handle.press("ArrowUp")
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(128)
  await handle.press("Home")
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(96)
  expect(await page.getByRole("button", { name: "Editor size" }).count()).toBe(0)
  await handle.press("End")
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(
    Number(await handle.getAttribute("aria-valuemax")),
  )
  const expand = page.getByRole("button", { name: "Expand editor" })
  await expand.focus()
  await expand.press("Enter")
  expect(await page.locator("#expanded").textContent()).toBe("true")
  await page.getByRole("button", { name: "Collapse editor" }).press("Enter")
  expect(await page.locator("#expanded").textContent()).toBe("false")
})

test("compact controls add no header row and appear only around the corner or on focus", async () => {
  await page.reload()
  await page.mouse.move(600, 20)
  const header = page.locator(".composer-resize-controls")
  expect(await header.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(12)
  const expand = page.getByRole("button", { name: "Expand editor" })
  expect(await expand.evaluate((element) => getComputedStyle(element).opacity)).toBe("0")
  await page.locator(".composer-expand-region").hover()
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector(".composer-expand-control")!).opacity === "1",
  )
  await page.mouse.move(600, 20)
  await page.keyboard.press("Tab")
  await expand.focus()
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector(".composer-expand-control")!).opacity === "1",
  )
  expect(await expand.evaluate((element) => getComputedStyle(element).opacity)).toBe("1")
  expect(await expand.locator("svg.lucide-maximize-2").count()).toBe(1)
  await expand.press("Enter")
  expect(await page.getByRole("button", { name: "Collapse editor" }).locator("svg.lucide-shrink").count()).toBe(1)
})

test("touch keeps the corner control visible and inside a 320px composer", async () => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 600 } })
  const touch = await context.newPage()
  try {
    await touch.goto(server.resolvedUrls!.local[0]!, { waitUntil: "domcontentloaded", timeout: 20_000 })
    const expand = touch.getByRole("button", { name: "Expand editor" })
    await expand.waitFor()
    expect(await expand.evaluate((element) => getComputedStyle(element).opacity)).toBe("1")
    const box = await expand.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)
  } finally {
    await context.close()
  }
}, 30_000)

import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let cache: string
beforeAll(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "composer-reader-test-"))
  const root = path.resolve(import.meta.dir, "../../fixtures/plugin-ui5")
  server = await createServer({
    cacheDir: cache,
    configFile: false,
    root,
    plugins: [
      solidPlugin(),
      {
        name: "resize-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/") return next()
            res.setHeader("Content-Type", "text/html")
            res.end('<div id="root"></div><script type="module" src="/composer-resize.tsx"></script>')
          })
        },
      },
    ],
    resolve: { alias: { "@": path.resolve(import.meta.dir, "../../../src") } },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.getByRole("separator", { name: "Resize editor" }).waitFor()
}, 30_000)
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
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(240)
  await page.keyboard.press("Escape")
  await page.mouse.up()
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(96)
  const next = await handle.boundingBox()
  await page.mouse.move(next!.x + next!.width / 2, next!.y + 12)
  await page.mouse.down()
  await page.mouse.move(x, next!.y - 190, { steps: 5 })
  expect(await page.locator(".composer-resize-cue").textContent()).toBe("Release to expand")
  await page.mouse.up()
  expect(await page.locator("#expanded").textContent()).toBe("true")
})

test("keyboard and menu resize without dragging and Escape returns focus", async () => {
  await page.reload()
  const handle = page.getByRole("separator", { name: "Resize editor" })
  await handle.press("ArrowUp")
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(128)
  await handle.press("Home")
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(96)
  const menu = page.getByRole("button", { name: "Editor size" })
  await menu.click()
  await page.getByRole("button", { name: "Automatic height" }).press("Escape")
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Editor size")
  expect(await menu.evaluate((el) => el === document.activeElement)).toBe(true)
  await menu.click()
  await page.getByRole("button", { name: "Taller editor" }).click()
  expect(await page.locator(".session-composer-editor").evaluate((el) => el.getBoundingClientRect().height)).toBe(240)
})

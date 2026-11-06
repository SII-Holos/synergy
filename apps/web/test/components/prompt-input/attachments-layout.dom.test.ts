import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

let browser: Browser
let page: Page
let server: ViteDevServer
let cache: string

beforeAll(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "composer-attachments-test-"))
  const root = path.resolve(import.meta.dir, "../../fixtures/plugin-ui5")
  server = await createServer({
    cacheDir: cache,
    configFile: false,
    root,
    plugins: [
      solidPlugin(),
      tailwind(),
      {
        name: "attachment-layout-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/") return next()
            res.setHeader("Content-Type", "text/html")
            res.end('<div id="root"></div><script type="module" src="/composer-attachments.tsx"></script>')
          })
        },
      },
    ],
    resolve: {
      alias: {
        "@/context/locale": path.join(root, "composer-attachments-locale.ts"),
        "@": path.resolve(import.meta.dir, "../../../src"),
      },
    },
    optimizeDeps: { noDiscovery: true, include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid"] },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(import.meta.dir, "../../../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/composer-attachments.tsx")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 600 } })
  page.setDefaultTimeout(5000)
  await page.goto(server.resolvedUrls!.local[0]!, { timeout: 30_000 })
  await page.locator('button[aria-label="Remove fourth.txt"]').waitFor({ state: "attached" })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (cache) await rm(cache, { recursive: true, force: true })
})

test.each([320, 375, 800])("draft attachments remain one reachable horizontal row at %ipx", async (width) => {
  await page.setViewportSize({ width, height: 600 })
  const layout = page.locator('[data-slot="attachment-row-layout"]')
  const boxes = await page
    .locator('[data-slot="attachment-row-entry"]')
    .evaluateAll((elements) =>
      elements.map((element) => ({ top: element.getBoundingClientRect().top, inert: element.hasAttribute("inert") })),
    )
  expect(boxes).toHaveLength(4)
  expect(Math.max(...boxes.map((box) => box.top)) - Math.min(...boxes.map((box) => box.top))).toBeLessThan(1)
  expect(boxes.some((box) => box.inert)).toBe(false)
  expect(await page.locator('[data-slot="attachment-rows-toggle"]').count()).toBe(0)
  expect(await layout.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  await page.getByRole("button", { name: "Remove fourth.txt" }).focus()
  expect(await layout.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
})

test("failure review scrolls to retry and removal restores adjacent focus without reordering", async () => {
  await page.setViewportSize({ width: 320, height: 600 })
  await page.getByRole("button", { name: "Review failed attachments" }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-slot") === "attachment-retry")
  expect(
    await page.locator('[data-slot="attachment-row-layout"]').evaluate((element) => element.scrollLeft),
  ).toBeGreaterThan(0)
  await page.getByRole("button", { name: "Retry upload" }).click()
  expect(await page.locator("#retried").textContent()).toBe("third")
  await page.getByRole("button", { name: "Remove third.txt" }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Remove fourth.txt")
  expect(await page.locator('[data-slot="attachment-card-filename"]').allTextContents()).toEqual([
    "first.txt",
    "second.txt",
    "fourth.txt",
  ])
  for (const name of ["first.txt", "second.txt", "fourth.txt"])
    await page.getByRole("button", { name: `Remove ${name}` }).click()
  await page.waitForFunction(() => document.activeElement?.classList.contains("prompt-input-add-button"))
})

test("draft image uploads and completed previews keep the same 96 by 72 tile with cover cropping", async () => {
  await page.goto(`${server.resolvedUrls!.local[0]}?image`)
  const card = page.locator('[data-component="attachment-card"]')
  await card.waitFor()
  const pending = await card.boundingBox()
  expect(pending?.width).toBe(96)
  expect(pending?.height).toBe(72)
  expect(await card.locator("img").evaluate((image) => getComputedStyle(image).objectFit)).toBe("cover")
  await page.evaluate("window.fixture.fail()")
  expect(await page.getByRole("button", { name: "Retry upload" }).isVisible()).toBe(true)
  expect(await card.boundingBox()).toMatchObject({ width: 96, height: 72 })
  await page.evaluate("window.fixture.complete()")
  await page.getByRole("button", { name: "Open portrait.svg" }).waitFor()
  expect(await card.boundingBox()).toMatchObject({ width: 96, height: 72 })
  expect(await card.locator("img").evaluate((image) => getComputedStyle(image).objectFit)).toBe("cover")
})

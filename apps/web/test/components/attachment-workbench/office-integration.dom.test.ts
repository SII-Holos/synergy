import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { build, createServer, preview, type ViteDevServer, type PreviewServer } from "vite"

let browser: Browser, page: Page, development: ViteDevServer, production: PreviewServer, cache: string
let developmentUrl: string, productionUrl: string
const appRoot = path.resolve(import.meta.dir, "../../..")
const fixture = path.resolve(import.meta.dir, "../../fixtures/office")
beforeAll(async () => {
  cache = await mkdtemp(path.join(tmpdir(), "office-integration-test-"))
  const config = {
    configFile: path.join(appRoot, "vite.config.ts"),
    root: fixture,
    cacheDir: path.join(cache, "dependencies"),
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "solid-js",
        "solid-js/web",
        "@lingui/solid",
        "@lingui/core",
        "docx-preview",
        "fflate",
        "saxes",
        "@office-kit/pptx",
        "@office-kit/pptx-preview",
        "dompurify",
      ],
    },
    build: {
      outDir: path.join(cache, "dist"),
      emptyOutDir: true,
      rollupOptions: { input: path.join(fixture, "integration.html") },
    },
    server: { host: "127.0.0.1", port: await fixturePort(), fs: { allow: [path.resolve(appRoot, "../..")] } },
  }
  development = await createServer(config)
  await development.listen()
  developmentUrl = new URL("integration.html", development.resolvedUrls!.local[0]!).href
  await build({ ...config, logLevel: "error" })
  production = await preview({ ...config, preview: { host: "127.0.0.1", port: await fixturePort() } })
  productionUrl = new URL("integration.html", production.resolvedUrls!.local[0]!).href
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
}, 90_000)
afterAll(async () => {
  await browser?.close()
  await development?.close()
  if (production) await new Promise<void>((resolve) => production.httpServer.close(() => resolve()))
  if (cache) await rm(cache, { recursive: true, force: true })
})

for (const environment of ["development", "production"] as const) {
  test(`${environment} configuration loads and reads all three Office formats`, async () => {
    const url = environment === "development" ? developmentUrl : productionUrl
    await page.goto(`${url}?format=docx&dialog`)
    await page.getByRole("button", { name: "Open preview", exact: true }).click()
    await page.locator(".office-reader-toolbar").getByText("1 / 2", { exact: true }).waitFor({ timeout: 15000 })
    const docFrame = page.frameLocator("iframe")
    await docFrame.getByText("中文阅读验收", { exact: true }).waitFor({ timeout: 8000 })
    expect(await docFrame.getByText("42", { exact: true }).isVisible()).toBe(true)
    expect((await docFrame.locator("body").boundingBox())!.width).toBeGreaterThan(0)
    expect(
      await docFrame.locator(".office-paper").evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe("rgb(255, 255, 255)")
    await page.getByRole("button", { name: "Close dialog", exact: true }).press("Escape")
    await page.waitForFunction(() => document.activeElement?.textContent === "Open preview")
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Open preview")
    await page.goto(`${url}?format=xlsx&dialog`)
    await page.getByRole("button", { name: "Open preview", exact: true }).click()
    await page.getByRole("grid", { name: "汇总" }).waitFor({ timeout: 15000 })
    expect(await page.getByRole("gridcell", { name: "中文标题", exact: true }).getAttribute("aria-colspan")).toBe("2")
    await page.getByRole("gridcell", { name: "25.00", exact: true }).click()
    expect(await page.locator(".xlsx-formula-bar input").inputValue()).toBe("=A2*2")
    await page.goto(`${url}?format=pptx&dialog`)
    await page.getByRole("button", { name: "Open preview", exact: true }).click()
    await page.locator(".office-reader-toolbar").getByText("1 / 2", { exact: true }).waitFor({ timeout: 15000 })
    await page.frameLocator("iframe").getByText("中文幻灯片标题😀", { exact: true }).waitFor({ timeout: 8000 })
    expect((await page.frameLocator("iframe").locator("svg").boundingBox())!.width).toBeGreaterThan(0)
    expect(await page.getByText("Unable to preview this attachment.").count()).toBe(0)
  }, 60000)
}

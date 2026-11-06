import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"
import { officeReaderFixture } from "../../support/office-fixture"
import type { BrowserFixture } from "../../support/browser-fixture"

let browser: Browser, page: Page, server: BrowserFixture
beforeAll(async () => {
  server = await officeReaderFixture()
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
})

beforeEach(async () => {
  page = await browser.newPage()
  await page.goto(new URL("pptx.html", server.url).href)
  await page.frameLocator("iframe").getByText("中文幻灯片标题😀", { exact: true }).waitFor()
})
afterEach(async () => {
  await page?.close()
})

test("PPTX preserves Chinese slides, tables, common shapes and embedded images in an opaque frame", async () => {
  expect(await page.locator(".office-reader-toolbar").textContent()).toContain("1 / 2")
  const frame = page.frameLocator("iframe")
  expect(await frame.getByText("中文表格", { exact: true }).count()).toBe(1)
  expect(await frame.getByText("常见形状", { exact: true }).count()).toBe(1)
  const image = frame.locator("svg image")
  const src = (await image.getAttribute("href")) ?? (await image.getAttribute("xlink:href"))
  expect(src).toStartWith("data:image/png")
  expect(await page.locator("iframe").getAttribute("sandbox")).toBe("")
  await page.getByRole("button", { name: "Next page", exact: true }).click()
  await frame.getByText("第二页幻灯片", { exact: true }).waitFor()
})

test("PPTX find, navigation and fit stay readable in a 320px short viewport", async () => {
  await page.setViewportSize({ width: 320, height: 420 })
  await page.getByRole("textbox", { name: "Find in document" }).fill("中文表格")
  await page.frameLocator("iframe").locator("mark").getByText("中文表格", { exact: true }).waitFor()
  expect(await page.getByRole("status").textContent()).toBe("1 matching pages")
  await page.getByRole("button", { name: "Fit width", exact: true }).click()
  const bounds = await page.getByRole("button", { name: "Zoom in", exact: true }).boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  expect(
    await page
      .frameLocator("iframe")
      .locator("svg")
      .boundingBox()
      .then((box) => box!.width),
  ).toBeLessThanOrEqual(288)
})

test("PPTX errors and closing a read keep stale content out of the surface", async () => {
  await page.getByRole("button", { name: "Corrupt sample", exact: true }).click()
  await page
    .getByText("This file is damaged or incomplete. Download the original to check it.", { exact: true })
    .waitFor()
  expect(await page.locator("iframe").count()).toBe(0)
  await page.getByRole("button", { name: "Encrypted sample", exact: true }).click()
  await page
    .getByText("Encrypted Office files cannot be previewed. Download the original to open it.", { exact: true })
    .waitFor()
  await page.getByRole("button", { name: "Valid sample", exact: true }).click()
  await page.getByRole("button", { name: "Toggle reader", exact: true }).click()
  expect(await page.locator(".office-reader").count()).toBe(0)
  await page.getByRole("button", { name: "Toggle reader", exact: true }).click()
  await page.frameLocator("iframe").getByText("中文幻灯片标题😀", { exact: true }).waitFor()
})

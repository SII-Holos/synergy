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
  await page.goto(new URL("docx.html", server.url).href)
  await page.frameLocator("iframe").getByText("中文阅读验收", { exact: true }).waitFor()
})
afterEach(async () => {
  await page?.close()
})

test("DOCX preserves pages, Chinese text, tables, embedded image and header/footer", async () => {
  expect(await page.locator(".office-reader-toolbar").textContent()).toContain("1 / 2")
  const frame = page.frameLocator("iframe")
  expect(await frame.getByText("中文表格", { exact: true }).count()).toBe(1)
  expect(await frame.getByText("测试页眉", { exact: true }).count()).toBe(1)
  expect(await frame.getByText("测试页脚", { exact: true }).count()).toBe(1)
  expect(await frame.locator("img").getAttribute("src")).toStartWith("data:image/png")
  expect(await page.locator("iframe").getAttribute("sandbox")).toBe("")
  await page.getByRole("button", { name: "Next page", exact: true }).click()
  await frame.getByText("第二页面正文", { exact: true }).waitFor()
})

test("a replacement document resets page navigation before reading a shorter file", async () => {
  await page.getByRole("button", { name: "Next page", exact: true }).click()
  await page.frameLocator("iframe").getByText("第二页面正文", { exact: true }).waitFor()
  await page.getByRole("button", { name: "Single page sample", exact: true }).click()
  await page.frameLocator("iframe").getByText("单页替换文档", { exact: true }).waitFor()
  expect(await page.locator(".office-reader-toolbar").textContent()).toContain("1 / 1")
  expect(await page.getByRole("button", { name: "Previous page", exact: true }).isDisabled()).toBe(true)
  expect(await page.getByRole("button", { name: "Next page", exact: true }).isDisabled()).toBe(true)
  await page.getByRole("button", { name: "Valid sample", exact: true }).click()
  await page.frameLocator("iframe").getByText("中文阅读验收", { exact: true }).waitFor()
})

test("DOCX search, fit and controls stay available in a 320px short viewport", async () => {
  await page.setViewportSize({ width: 320, height: 420 })
  await page.getByRole("textbox", { name: "Find in document" }).fill("中文表格")
  await page.frameLocator("iframe").locator("mark").getByText("中文表格", { exact: true }).waitFor()
  expect(await page.getByRole("status").textContent()).toBe("1 matching pages")
  await page.getByRole("button", { name: "Fit width", exact: true }).click()
  const bounds = await page.getByRole("button", { name: "Zoom in", exact: true }).boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
})

test("damaged and encrypted DOCX stay within the reader error surface", async () => {
  await page.getByRole("button", { name: "Corrupt sample", exact: true }).click()
  await page
    .getByText("This file is damaged or incomplete. Download the original to check it.", { exact: true })
    .waitFor()
  expect(await page.locator("iframe").count()).toBe(0)
  await page.getByRole("button", { name: "Encrypted sample", exact: true }).click()
  await page
    .getByText("Encrypted Office files cannot be previewed. Download the original to open it.", { exact: true })
    .waitFor()
})

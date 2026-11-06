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
  page = await browser.newPage({ permissions: ["clipboard-read", "clipboard-write"] })
  await page.goto(new URL("xlsx.html", server.url).href)
  await page.getByRole("grid", { name: "汇总" }).waitFor()
})
afterEach(async () => {
  await page?.close()
})

test("XLSX reads cached formulas, merges, worksheets and copied selection", async () => {
  const grid = page.getByRole("grid", { name: "汇总" })
  expect(await page.getByRole("gridcell", { name: "中文标题", exact: true }).getAttribute("aria-colspan")).toBe("2")
  await page.getByRole("gridcell", { name: "25.00", exact: true }).click()
  expect(await page.getByRole("textbox", { name: "Cell value or formula" }).inputValue()).toBe("=A2*2")
  await grid.press("Shift+ArrowLeft")
  await page.getByRole("button", { name: "Copy selected cells", exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("12.5\t25.00")
  await page.getByRole("button", { name: "明细", exact: true }).click()
  await page.getByRole("gridcell", { name: "第二工作表", exact: true }).waitFor()
  await page.getByRole("button", { name: "汇总", exact: true }).click()
  await grid.waitFor()
})

test("XLSX virtualizes distant rows and search does not reset keyboard navigation", async () => {
  const grid = page.getByRole("grid", { name: "汇总" })
  await grid.press("Control+End")
  await page.getByRole("gridcell", { name: "远端单元格", exact: true }).waitFor()
  expect(await page.getByRole("gridcell").count()).toBeLessThan(150)
  await page.getByRole("textbox", { name: "Find in document" }).fill("数据")
  await page.getByRole("gridcell", { name: "数据", exact: true }).waitFor()
  await grid.press("ArrowDown")
  expect(await page.locator(".xlsx-formula-bar strong").textContent()).toBe("C3")
})

test("XLSX toolbar and worksheet access remain inside 320px bounds", async () => {
  await page.setViewportSize({ width: 320, height: 420 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  const copy = await page.getByRole("button", { name: "Copy selected cells", exact: true }).boundingBox()
  expect(copy!.x + copy!.width).toBeLessThanOrEqual(320)
  const tabs = await page.getByRole("button", { name: "明细", exact: true }).boundingBox()
  expect(tabs!.y + tabs!.height).toBeLessThanOrEqual(420)
})

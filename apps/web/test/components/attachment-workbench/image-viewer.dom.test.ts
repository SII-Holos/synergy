import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser, page: Page, server: BrowserFixture
beforeAll(async () => {
  server = await createBrowserFixture({
    root: path.resolve(import.meta.dir, "../../fixtures/image-viewer"),
    entries: ["viewer.html"],
    styled: true,
    localized: false,
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
}, 60000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
})

beforeEach(async () => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto(`${server.url}viewer.html`)
  await page.getByRole("button", { name: "Open images", exact: true }).click()
  await page.locator('[data-slot="image-viewer-image"]').evaluate((element: HTMLImageElement) => element.decode())
  await page.waitForFunction(
    () => document.querySelector('[data-slot="image-viewer-stage"]')?.getAttribute("aria-busy") === "false",
  )
})

test("fit and actual size use source pixels and rotation refits the stage", async () => {
  await page.getByRole("button", { name: "Fit image", exact: true }).waitFor({ timeout: 3000 })
  const image = page.locator('[data-slot="image-viewer-image"]')
  await image.evaluate((element: HTMLImageElement) => element.decode())
  await page.getByRole("button", { name: "Actual size (1:1)", exact: true }).click()
  expect((await image.boundingBox())!.width).toBeCloseTo(4000, 0)
  await page.getByRole("button", { name: "Fit image", exact: true }).click()
  await page.getByRole("button", { name: "Rotate image clockwise", exact: true }).click()
  const bounds = (await image.boundingBox())!
  const stage = (await page.locator('[data-slot="image-viewer-stage"]').boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(stage.x)
  expect(bounds.y).toBeGreaterThanOrEqual(stage.y)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(stage.x + stage.width)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(stage.y + stage.height)
})

test("same-source gallery entries load and restore their own transform", async () => {
  await page.getByRole("button", { name: "Actual size (1:1)", exact: true }).click()
  await page.getByRole("button", { name: "Next image", exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('[data-slot="image-viewer-stage"]')?.getAttribute("aria-busy") === "false",
  )
  expect(await page.getByRole("dialog").getAttribute("aria-labelledby")).toBeTruthy()
  expect(await page.getByRole("button", { name: "Fit image", exact: true }).getAttribute("aria-pressed")).toBe("true")
  await page.getByRole("button", { name: "Previous image", exact: true }).click()
  await page.locator('[data-slot="image-viewer-image"]').evaluate((element: HTMLImageElement) => element.decode())
  expect((await page.locator('[data-slot="image-viewer-image"]').boundingBox())!.width).toBeCloseTo(4000, 0)
})

test("wheel anchors source pixels and captured dragging remains bounded", async () => {
  await page.getByRole("button", { name: "Actual size (1:1)", exact: true }).click()
  const image = page.locator('[data-slot="image-viewer-image"]')
  const stage = page.locator('[data-slot="image-viewer-stage"]')
  const box = (await stage.boundingBox())!
  const anchor = { x: box.x + box.width / 2 + 45, y: box.y + box.height / 2 + 35 }
  const before = (await image.boundingBox())!
  await page.mouse.move(anchor.x, anchor.y)
  await page.mouse.wheel(0, -100)
  await page.waitForFunction(
    (width) => document.querySelector('[data-slot="image-viewer-image"]')!.getBoundingClientRect().width > width,
    before.width,
  )
  const after = (await image.boundingBox())!
  expect((anchor.x - before.x) / before.width).toBeCloseTo((anchor.x - after.x) / after.width, 3)
  expect((anchor.y - before.y) / before.height).toBeCloseTo((anchor.y - after.y) / after.height, 3)
  await page.getByRole("button", { name: "Actual size (1:1)", exact: true }).click()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(1198, 798, { steps: 3 })
  await page.mouse.up()
  const dragged = (await image.boundingBox())!
  expect(dragged.x).toBeLessThanOrEqual(box.x)
  expect(dragged.y).toBeLessThanOrEqual(box.y)
  await page.getByRole("button", { name: "Fit image", exact: true }).click()
  const fit = (await image.boundingBox())!
  expect(fit.x + fit.width / 2).toBeCloseTo(box.x + box.width / 2, 1)
})

test("context and overflow menus share actions and Escape closes only the menu", async () => {
  await page.locator('[data-slot="image-viewer-stage"]').click({ button: "right" })
  await page.getByRole("menuitem", { name: "Transparency grid", exact: true }).waitFor({ timeout: 3000 })
  await page.getByRole("menuitem", { name: "Transparency grid", exact: true }).click()
  expect(await page.locator('[data-slot="image-viewer-stage"]').getAttribute("data-grid")).toBeNull()
  await page.getByRole("button", { name: "Image actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Actual size (1:1)", exact: true }).waitFor()
  await page.keyboard.press("Escape")
  expect(await page.getByRole("menu").count()).toBe(0)
  expect(await page.getByRole("dialog").count()).toBe(1)
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await page.waitForFunction(() => document.activeElement?.textContent === "Open images")
  expect(
    await page
      .getByRole("button", { name: "Open images", exact: true })
      .evaluate((element) => element === document.activeElement),
  ).toBe(true)
})

test("failed images retry the same URL and recover", async () => {
  let failed = true
  await page.route("**/retry.svg", (route) =>
    route.fulfill(
      failed
        ? { status: 503, body: "unavailable" }
        : { contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="30"/>' },
    ),
  )
  await page.evaluate(() => {
    const fixture = (window as unknown as { imageFixture: { setImages: (images: unknown[]) => void } }).imageFixture
    fixture.setImages([
      { id: "retry", src: `${location.origin}/retry.svg`, filename: "retry.svg", mime: "image/svg+xml" },
    ])
  })
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Zoom in", exact: true }).isDisabled()).toBe(true)
  failed = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('[data-slot="image-viewer-stage"]')?.getAttribute("aria-busy") === "false",
  )
  expect(await page.getByRole("button", { name: "Zoom in", exact: true }).isEnabled()).toBe(true)
  await page.unroute("**/retry.svg")
})

test("short windows keep close, stage and all toolbar controls reachable", async () => {
  await page.setViewportSize({ width: 375, height: 320 })
  for (const name of ["Close image preview", "Fit image", "Image actions"]) {
    const button = page.getByRole("button", { name, exact: true })
    await button.scrollIntoViewIfNeeded()
    const box = (await button.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(320)
  }
  const stage = (await page.locator('[data-slot="image-viewer-stage"]').boundingBox())!
  expect(stage.height).toBeGreaterThan(0)
})

test("web save delivers original bytes and reports dispatch, not saved", async () => {
  const pending = page.waitForEvent("download")
  await page.getByRole("button", { name: "Save image", exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe("large.svg")
  const bytes = await Bun.file((await download.path())!).text()
  expect(bytes).toContain('width="4000"')
  await page.getByText("Download started", { exact: true }).waitFor()
  expect(await page.getByText("Image saved", { exact: true }).count()).toBe(0)
})

test("real clipboard receives PNG pixels rather than a link", async () => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.getByRole("button", { name: "Copy image", exact: true }).click()
  await page.getByText("Image copied", { exact: true }).waitFor()
  const result = await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const blob = await items[0]!.getType("image/png")
    const image = await createImageBitmap(blob)
    return { type: blob.type, width: image.width, height: image.height }
  })
  expect(result).toEqual({ type: "image/png", width: 4000, height: 3000 })
})

test("fullscreen portals stay inside the image viewer", async () => {
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click()
  await page.waitForFunction(() => document.fullscreenElement?.getAttribute("data-component") === "image-viewer")
  await page.getByRole("button", { name: "Image actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Exit fullscreen", exact: true }).waitFor()
  expect(await page.getByRole("menu").evaluate((element) => document.fullscreenElement?.contains(element))).toBe(true)
  await page.getByRole("menuitem", { name: "Exit fullscreen", exact: true }).click()
  await page.waitForFunction(() => !document.fullscreenElement)
  expect(await page.getByRole("dialog").count()).toBe(1)
})

test("shrinking a gallery clamps its position, selection and next navigation together", async () => {
  await page.getByRole("button", { name: "small.svg", exact: true }).click()
  await page.evaluate(() => {
    const image = document.querySelector<HTMLImageElement>('[data-slot="image-viewer-thumbnails"] img')!
    const fixture = (window as unknown as { imageFixture: { setImages: (images: unknown[]) => void } }).imageFixture
    fixture.setImages([
      { id: "first", src: image.src, filename: "large.svg", mime: "image/svg+xml" },
      { id: "same", src: image.src, filename: "same-source.svg", mime: "image/svg+xml" },
    ])
  })
  expect(await page.locator('[data-slot="image-viewer-footer"]').innerText()).toContain("2 / 2")
  expect(await page.getByRole("button", { name: "same-source.svg", exact: true }).getAttribute("aria-current")).toBe(
    "true",
  )
  await page.getByRole("button", { name: "Previous image", exact: true }).click()
  expect(await page.locator('[data-slot="image-preview-title"]').innerText()).toBe("large.svg")
})

test("fullscreen Tab and Shift+Tab wrap within visible viewer controls", async () => {
  await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click()
  await page.waitForFunction(() => !!document.fullscreenElement)
  await page.locator('[data-slot="image-viewer-stage"]').click({ button: "right" })
  await page.getByRole("menu").waitFor()
  await page.keyboard.press("Escape")
  await page.locator('[data-component="image-viewer-menu"]').waitFor({ state: "detached" })
  await page.locator('[data-component="image-viewer"] > [data-focus-trap]').first().waitFor({ state: "attached" })
  const first = page.getByRole("button", { name: "Fit image", exact: true })
  const last = page.getByRole("button", { name: "small.svg", exact: true })
  await last.focus()
  await page.keyboard.press("Tab")
  expect(await first.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.keyboard.press("Shift+Tab")
  expect(await last.evaluate((element) => element === document.activeElement)).toBe(true)
  await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click()
  await page.waitForFunction(() => !document.fullscreenElement)
})

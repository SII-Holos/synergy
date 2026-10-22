import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let browser: Browser, page: Page, server: BrowserFixture, url: string
const requested: string[] = []
beforeAll(async () => {
  const root = path.resolve(import.meta.dir, "../../fixtures/attachment-workbench")
  server = await createBrowserFixture({
    root,
    entries: ["content.html"],
    styled: true,
    aliases: [
      ...["file", "sdk", "platform", "workbench"].map((name) => ({
        find: `@/context/${name}`,
        replacement: path.join(root, "contexts.ts"),
      })),
      { find: "@", replacement: path.resolve(import.meta.dir, "../../../src") },
    ],
  })
  url = new URL("content.html", server.url).href
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.route("**/session/*/message/*", async (route) => {
    requested.push(new URL(route.request().url()).pathname)
    await route.fulfill({
      json: {
        parts: [
          {
            id: "attachment-original",
            sessionID: "session-original",
            messageID: "message-original",
            type: "attachment",
            mime: "image/svg+xml",
            filename: "history.svg",
            url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          },
        ],
      },
    })
  })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
})

test("an uploaded attachment reads without a File provider and keeps its original download", async () => {
  await page.goto(url)
  await page.locator(".attachment-workbench,[role=alert]").waitFor({ timeout: 10000 })
  expect(await page.locator("[role=alert]").allTextContents()).toEqual([])
  await page.getByRole("link", { name: "Download", exact: true }).waitFor({ timeout: 5000 })
  expect(await page.locator("[role=alert]").count()).toBe(0)
  expect(await page.getByRole("img", { name: "original.svg" }).isVisible()).toBe(true)
  expect(await page.getByRole("link", { name: "Download", exact: true }).getAttribute("download")).toBe("original.svg")
  expect(await page.getByRole("button", { name: "View source in Files" }).count()).toBe(0)
})
test("source navigation uses an optional host binding", async () => {
  await page.goto(`${url}?source`)
  await page.locator(".attachment-workbench,[role=alert]").waitFor({ timeout: 10000 })
  expect(await page.locator("[role=alert]").allTextContents()).toEqual([])
  await page.getByRole("button", { name: "View source in Files" }).click({ timeout: 5000 })
  expect(await page.getByLabel("Opened source").textContent()).toBe("docs/original.svg")
})
test("an evicted message is read using its original session and message identity", async () => {
  await page.goto(`${url}?remote`)
  await page.locator(".attachment-workbench,[role=alert]").waitFor({ timeout: 10000 })
  expect(await page.locator("[role=alert]").allTextContents()).toEqual([])
  await page.getByRole("link", { name: "Download", exact: true }).waitFor({ timeout: 5000 })
  expect(await page.getByRole("img", { name: "history.svg" }).isVisible()).toBe(true)
  expect(requested.at(-1)).toBe("/session/session-original/message/message-original")
})

test("an evicted message read failure stays local and can be retried", async () => {
  let failed = true
  await page.route("**/session/session-original/message/message-original", async (route) => {
    if (failed) {
      failed = false
      await route.fulfill({ status: 503, body: "Unavailable" })
    } else await route.fallback()
  })
  await page.goto(`${url}?remote`)
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByRole("img", { name: "history.svg" }).waitFor()
  expect(await page.locator("[role=alert]").count()).toBe(0)
  await page.unroute("**/session/session-original/message/message-original")
})

for (const locale of ["en", "zh-CN", "pseudo"])
  test(`${locale} attachment toolbar keeps metadata and actions inside a narrow pane`, async () => {
    await page.setViewportSize({ width: 1440, height: 750 })
    for (const theme of ["light", "dark"]) {
      await page.goto(`${url}?html&source&locale=${locale}&theme=${theme}`)
      const toolbar = page.locator(".attachment-workbench-toolbar")
      await toolbar.waitFor()
      await page.evaluate(() => document.fonts.ready)
      for (const width of [320, 375, 520, 521, 720, 1024, 1025, 1100, 375]) {
        await page.locator("#preview-pane").evaluate((node, width) => (node.style.width = `${width}px`), width)
        const labels = toolbar.locator(".attachment-workbench-action > span")
        expect(await labels.count()).toBe(4)
        for (const label of await labels.all()) expect(await label.isVisible()).toBe(width > 1024)
        const geometry = await toolbar.evaluate((node) => {
          const bounds = node.getBoundingClientRect()
          const heading = node.querySelector(".attachment-workbench-heading")!.getBoundingClientRect()
          const actions = node.querySelector(".attachment-workbench-actions")!.getBoundingClientRect()
          return {
            overflow: node.scrollWidth > node.clientWidth,
            headingWidth: heading.width,
            separated: heading.right <= actions.left + 1 || heading.bottom <= actions.top + 1,
            controls: Array.from(node.querySelectorAll("button,a"), (control) => {
              const box = control.getBoundingClientRect()
              return (
                box.left >= bounds.left && box.right <= bounds.right && control.scrollWidth <= control.clientWidth + 1
              )
            }),
          }
        })
        expect(geometry.overflow).toBe(false)
        expect(geometry.headingWidth).toBeGreaterThan(60)
        expect(geometry.separated).toBe(true)
        expect(geometry.controls.every(Boolean)).toBe(true)
        for (const action of await toolbar.locator(".attachment-workbench-action").all()) {
          expect(await action.getAttribute("aria-label")).toBeTruthy()
        }
        expect(await toolbar.locator('[role="group"] button').first().isVisible()).toBe(true)
        expect(await toolbar.locator('[role="group"] button').last().isVisible()).toBe(true)
      }
    }
  })

test.each(["png", "svg"])("%s images share compact external-open and download actions", async (kind) => {
  await page.setViewportSize({ width: 1440, height: 750 })
  for (const theme of ["light", "dark"]) {
    await page.goto(`${url}?${kind === "png" ? "png&" : ""}locale=zh-CN&theme=${theme}`)
    const toolbar = page.locator(".attachment-workbench-toolbar")
    await page.locator(".attachment-workbench-toolbar,[role=alert]").waitFor()
    expect(await page.locator("[role=alert]").allTextContents()).toEqual([])
    await page.locator(".attachment-image-stage img").evaluate((image: HTMLImageElement) => image.decode())
    const external = page.getByRole("button", { name: "在你的浏览器中打开", exact: true })
    const download = page.getByRole("link", { name: "下载", exact: true })
    for (const width of [375, 720, 1024, 1100, 375]) {
      await page.locator("#preview-pane").evaluate((node, width) => (node.style.width = `${width}px`), width)
      for (const action of [external, download]) {
        expect(await action.isVisible()).toBe(true)
        expect(await action.locator(":scope > span").isVisible()).toBe(width > 1024)
        const bounds = await action.boundingBox()
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      }
      expect(await toolbar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    }
    await external.focus()
    await page.getByRole("tooltip").waitFor({ state: "visible" })
    expect(await page.getByRole("tooltip").innerText()).toBe("在你的浏览器中打开")
    expect(await download.getAttribute("download")).toBe(
      kind === "png" ? "narrow-panel-image-preview.png" : "original.svg",
    )
    expect(await download.getAttribute("href")).toContain(
      kind === "png" ? "data:image/png;base64," : "data:image/svg+xml,",
    )
  }
})

test("compact attachment controls retain names, help and keyboard source switching", async () => {
  await page.setViewportSize({ width: 1440, height: 750 })
  await page.goto(`${url}?html&source&locale=zh-CN`)
  await page.locator("#preview-pane").evaluate((node) => (node.style.width = "375px"))
  const source = page.getByRole("button", { name: "源文件", exact: true })
  await source.focus()
  await page.keyboard.press("Enter")
  expect(await source.getAttribute("aria-pressed")).toBe("true")
  await page.locator(".attachment-source-preview").waitFor()
  await page.keyboard.press("Tab")
  const preview = page.getByRole("button", { name: "预览", exact: true })
  expect(await preview.evaluate((node) => node === document.activeElement)).toBe(true)
  await page.keyboard.press("Space")
  expect(await preview.getAttribute("aria-pressed")).toBe("true")
  await page.keyboard.press("Tab")
  const openSource = page.getByRole("button", { name: "在“文件”中查看源文件", exact: true })
  expect(await openSource.evaluate((node) => node === document.activeElement)).toBe(true)
  await page.getByRole("tooltip").waitFor({ state: "visible" })
  expect(await page.getByRole("tooltip").innerText()).toBe("在“文件”中查看源文件")
  await page.keyboard.press("Enter")
  expect(await page.getByLabel("Opened source").textContent()).toBe("docs/original.svg")
  const download = page.getByRole("link", { name: "下载", exact: true })
  expect(await download.getAttribute("download")).toBe("responsive-preview-with-a-long-filename.html")
  expect(await download.getAttribute("href")).toContain("data:text/html,")
})

test("phone attachment actions retain non-overlapping touch targets without horizontal overflow", async () => {
  const phone = await browser.newPage({ viewport: { width: 375, height: 750 }, isMobile: true, hasTouch: true })
  try {
    await phone.goto(`${url}?html&source&locale=zh-CN`)
    const toolbar = phone.locator(".attachment-workbench-toolbar")
    await toolbar.waitFor()
    expect(await phone.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
    const geometry = await toolbar.evaluate((node) => {
      const bounds = node.getBoundingClientRect()
      const targets = Array.from(node.querySelectorAll("button,a"), (control) => control.getBoundingClientRect())
      return {
        width: bounds.width,
        overflow: document.documentElement.scrollWidth > innerWidth,
        contained: targets.every((target) => target.left >= bounds.left && target.right <= bounds.right),
        sized: targets.every((target) => target.width >= 44 && target.height >= 44),
        separated: targets.every((target, i) =>
          targets
            .slice(i + 1)
            .every(
              (other) =>
                target.right <= other.left ||
                other.right <= target.left ||
                target.bottom <= other.top ||
                other.bottom <= target.top,
            ),
        ),
      }
    })
    expect(geometry).toEqual({ width: 375, overflow: false, contained: true, sized: true, separated: true })
  } finally {
    await phone.close()
  }
})

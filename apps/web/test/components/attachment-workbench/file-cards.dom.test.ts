import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let fixture: BrowserFixture, browser: Browser, page: Page
const errors: string[] = []
beforeAll(async () => {
  fixture = await createBrowserFixture({
    root: path.resolve(import.meta.dir, "../../fixtures/attachment-workbench"),
    entries: ["file-cards.html"],
    styled: true,
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1000, height: 1100 }, reducedMotion: "reduce" })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (error) => errors.push(error.message))
}, 90_000)
afterAll(async () => {
  await browser?.close()
  await fixture?.close()
})
async function visit(theme = "light") {
  errors.length = 0
  await page.goto(`${fixture.url}file-cards.html?theme=${theme}`)
  await page.locator('[data-example="process"] [data-component="attachment-card"]').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
}
for (const theme of ["light", "dark"]) {
  test(`${theme}: file titles and metadata share one left edge with a compact hierarchy`, async () => {
    await visit(theme)
    const rows = await page
      .locator(
        '[data-component="attachment-card"]:is([data-type="file"],[data-type="pdf"]):not([data-upload-state="failed"])',
      )
      .evaluateAll((cards) =>
        cards
          .filter((card) => card.getClientRects().length)
          .map((card) => {
            function firstGlyph(element: Element) {
              const nodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
              let node: Node | null
              while ((node = nodes.nextNode())) {
                if (!node.textContent?.trim()) continue
                const range = document.createRange()
                const start = node.textContent.search(/\S/)
                range.setStart(node, start)
                range.setEnd(node, start + 1)
                return range.getBoundingClientRect().left
              }
              throw new Error("No attachment text")
            }
            const title = card.querySelector('[data-slot="attachment-card-filename"]')!
            const meta = card.querySelector('[data-slot="attachment-card-meta"]')!
            const canvas = document.createElement("canvas")
            canvas.width = canvas.height = 1
            const context = canvas.getContext("2d")!
            function luminance(color: string) {
              context.fillStyle = color
              context.fillRect(0, 0, 1, 1)
              const rgb = Array.from(context.getImageData(0, 0, 1, 1).data)
                .slice(0, 3)
                .map((value) => {
                  const channel = value / 255
                  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
                })
              return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
            }
            const foreground = luminance(getComputedStyle(meta).color)
            const background = luminance(getComputedStyle(card).backgroundColor)
            return {
              title: firstGlyph(title),
              meta: firstGlyph(meta),
              titleSize: parseFloat(getComputedStyle(title).fontSize),
              metaSize: parseFloat(getComputedStyle(meta).fontSize),
              height: card.getBoundingClientRect().height,
              contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
            }
          }),
      )
    expect(rows.length).toBeGreaterThan(6)
    for (const row of rows) {
      expect(Math.abs(row.title - row.meta)).toBeLessThanOrEqual(1)
      expect(row.metaSize).toBeLessThan(row.titleSize)
      expect(row.height).toBeGreaterThanOrEqual(44)
      expect(row.height).toBeLessThanOrEqual(60)
      expect(row.contrast).toBeGreaterThanOrEqual(4.5)
    }
    expect(
      await page.evaluate(() =>
        Array.from(document.fonts).some(
          (font) => font.family.replaceAll('"', "") === "Inter" && font.status === "loaded",
        ),
      ),
    ).toBe(true)
    expect(errors).toEqual([])
  })
}
test("narrow files retain their extension without overflow and real image geometry is unchanged", async () => {
  await visit()
  await page.locator('[data-example="narrow"]').evaluate((element) => (element.style.display = "block"))
  for (const width of [176, 240, 320]) {
    await page.locator("#narrow-pane").evaluate((element, width) => (element.style.width = `${width}px`), width)
    const layout = await page.locator("#narrow-pane").evaluate((pane) => {
      const card = pane.querySelector('[data-component="attachment-card"]')!
      const title = card.querySelector('[data-slot="attachment-card-filename"]')!
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT)
      const nodes: Node[] = []
      while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) nodes.push(walker.currentNode)
      const last = nodes.at(-1)!
      const range = document.createRange()
      range.setStart(last, last.textContent!.length - 5)
      range.setEnd(last, last.textContent!.length)
      return {
        pane: pane.getBoundingClientRect().right,
        card: card.getBoundingClientRect().right,
        extension: range.getBoundingClientRect().right,
      }
    })
    expect(layout.card).toBeLessThanOrEqual(layout.pane + 1)
    expect(layout.extension).toBeLessThanOrEqual(layout.card)
  }
  for (const image of await page.locator('[data-example="images"] [data-component="attachment-card"]').all()) {
    expect(await image.boundingBox()).toMatchObject({ width: 120, height: 96 })
  }
})
test("file opening, failed upload retry and removal retain their native keyboard actions", async () => {
  await visit()
  const file = page.locator('[data-example="process"] [data-component="attachment-card"]').first()
  await file.focus()
  await file.press("Enter")
  expect(
    await page.evaluate(() => (window as unknown as { fileCards: { opened: string[] } }).fileCards.opened),
  ).toEqual(["message.html"])
  const failed = page.locator('[data-upload-state="failed"]')
  expect((await failed.getByRole("button").first().textContent())?.trim()).toBe("重试上传")
  await failed.getByRole("button").first().focus()
  await page.getByRole("tooltip").waitFor()
  expect(await page.getByRole("tooltip").textContent()).toContain("The upload was interrupted")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Enter")
  await page.locator('[data-upload-state="uploading"]').filter({ hasText: "quarterly-review.pdf" }).waitFor()
  await page
    .getByRole("button", { name: /quarterly-review.pdf/ })
    .last()
    .focus()
  await page.keyboard.press("Space")
  expect(
    await page
      .locator('[data-upload-state] [data-slot="attachment-card-filename"]')
      .filter({ hasText: "quarterly-review.pdf" })
      .count(),
  ).toBe(0)
  expect(errors).toEqual([])
})

test("message attachments share a row when their visible widths fit", async () => {
  await page.setViewportSize({ width: 1000, height: 1100 })
  await visit()
  const cards = await page.locator('[data-example="message"] [data-component="attachment-card"]').all()
  const first = (await cards[0]!.boundingBox())!
  const second = (await cards[1]!.boundingBox())!
  expect(first.y).toBe(second.y)
  expect(second.x).toBeGreaterThan(first.x + first.width)
})

test("long standard and compact filenames stay inside phone-width pages", async () => {
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 1300 })
    await visit()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    const boxes = await page
      .locator('[data-component="attachment-card"]')
      .evaluateAll((cards) =>
        cards
          .filter((card) => card.getClientRects().length)
          .map((card) => ({ left: card.getBoundingClientRect().left, right: card.getBoundingClientRect().right })),
      )
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(width)
    }
  }
})

test("touch upload actions remain separate 44px targets with visible retry text", async () => {
  const touch = await browser.newPage({ viewport: { width: 375, height: 1200 }, hasTouch: true, isMobile: true })
  try {
    await touch.goto(`${fixture.url}file-cards.html?locale=en`)
    const failed = touch.locator('[data-upload-state="failed"]')
    await failed.waitFor()
    const retry = failed.getByRole("button", { name: "Retry upload", exact: true })
    const remove = touch.getByRole("button", { name: "Remove quarterly-review.pdf", exact: true })
    const retryBox = (await retry.boundingBox())!
    const removeBox = (await remove.boundingBox())!
    const cardBox = (await failed.boundingBox())!
    for (const box of [retryBox, removeBox]) {
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(cardBox.x)
      expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)
    }
    expect(retryBox.x + retryBox.width).toBeLessThanOrEqual(removeBox.x)
    expect(await retry.innerText()).toBe("Retry upload")
    expect(await failed.locator('[data-slot="attachment-card-meta"]').innerText()).toBe("Upload failed")
    await retry.tap()
    await touch.locator('[data-upload-state="uploading"]').filter({ hasText: "quarterly-review.pdf" }).waitFor()
  } finally {
    await touch.close()
  }
})

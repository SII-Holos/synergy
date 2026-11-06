import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"

let browser: Browser | undefined
let page: Page
let messagePartCss: string

beforeAll(async () => {
  messagePartCss = await Bun.file(new URL("../../src/components/message-part.css", import.meta.url)).text()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
})

afterAll(async () => {
  await browser?.close()
})

describe("Dedicated tool card motion", () => {
  test("keeps tool-card entrance out of the layout axis", async () => {
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.setContent(`
      <style>
        ${messagePartCss}
      </style>
      <div data-component="tool-part-wrapper">
        <div data-component="tool-card-area" style="width: 200px; height: 32px"></div>
      </div>
    `)

    const positions = await page.locator('[data-component="tool-part-wrapper"]').evaluate((wrapper) => {
      const animation = wrapper.getAnimations()[0]
      if (!animation) throw new Error("Expected tool entrance animation")
      animation.pause()
      animation.currentTime = 0
      const start = wrapper.getBoundingClientRect().top
      animation.currentTime = 250
      const end = wrapper.getBoundingClientRect().top
      return { start, end }
    })

    expect(Math.abs(positions.end - positions.start)).toBeLessThanOrEqual(1)
  })

  test("disables tool-card entrance when reduced motion is preferred", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.setContent(`
      <style>
        ${messagePartCss}
      </style>
      <div data-component="tool-part-wrapper">
        <div data-component="tool-card-area" style="width: 200px; height: 32px"></div>
      </div>
    `)

    expect(
      await page.locator('[data-component="tool-part-wrapper"]').evaluate((wrapper) => wrapper.getAnimations()),
    ).toHaveLength(0)
  })
})

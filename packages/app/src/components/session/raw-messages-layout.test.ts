import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { chromium, type Browser } from "playwright"

const css = await readFile(new URL("./raw-messages-dialog.css", import.meta.url), "utf8")
let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

describe("raw messages responsive layout", () => {
  test("keeps every narrow preview action at least 44px tall", async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 300 } })
    try {
      await page.setContent(`
        <style>${css}</style>
        <div class="raw-messages-preview-actions">
          <button data-component="button" style="height: 22px">Wrap lines</button>
          <button data-component="icon-button" style="height: 24px">Copy</button>
        </div>
      `)

      const heights = await page
        .locator("button")
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))
      expect(heights).toEqual([44, 44])
    } finally {
      await page.close()
    }
  })

  test("gives exceptional flags the full metadata row", async () => {
    const page = await browser.newPage({ viewport: { width: 768, height: 300 } })
    try {
      await page.setContent(`
        <style>*, ::before, ::after { box-sizing: border-box; } ${css}</style>
        <div class="raw-message-row" style="width: 300px">
          <label class="raw-message-row-select"></label>
          <button class="raw-message-row-main has-flags">
            <strong class="raw-message-row-role">Assistant</strong>
            <span class="raw-message-row-metadata">
              <span class="raw-message-id">
                <span class="raw-message-id-leading">msg_000000000000000000</span>
                <span class="raw-message-id-trailing">00000001</span>
              </span>
            </span>
            <time>10:15:30 PM</time>
            <span class="raw-message-flags">Hidden · Excluded</span>
          </button>
        </div>
      `)

      const layout = await page.locator(".raw-message-flags").evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          gridColumnStart: style.gridColumnStart,
          gridColumnEnd: style.gridColumnEnd,
        }
      })
      expect(layout.gridColumnStart).toBe("1")
      expect(layout.gridColumnEnd).toBe("-1")
      expect(layout.clientWidth).toBeGreaterThanOrEqual(layout.scrollWidth)
    } finally {
      await page.close()
    }
  })

  test("leaves horizontal scrolling to the shared code renderer", async () => {
    const page = await browser.newPage({ viewport: { width: 500, height: 300 } })
    try {
      await page.setContent(`
        <style>*, ::before, ::after { box-sizing: border-box; } ${css}</style>
        <div class="raw-messages-code-scroll" style="width: 320px; height: 120px">
          <div class="raw-message-code-content">
            <div data-component="code"></div>
          </div>
        </div>
      `)

      const layout = await page.locator(".raw-messages-code-scroll").evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      expect(layout.scrollWidth).toBe(layout.clientWidth)
    } finally {
      await page.close()
    }
  })
})

import { describe, expect, test } from "bun:test"
import { chromium } from "playwright"

const stylesUrl = new URL("../../../src/components/file-workbench/styles.css", import.meta.url)

describe("file workbench preview selection", () => {
  test("allows mouse selection inside a Markdown preview", async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 240 } })
      const styles = await Bun.file(stylesUrl).text()
      await page.setContent(`
        <style>
          ${styles}
        </style>
        <div style="-webkit-user-select: none; user-select: none;">
          <div class="file-markdown-preview">
            <div data-component="markdown">
              <p data-preview-text>Select this preview text</p>
            </div>
          </div>
        </div>
      `)

      await page.locator("[data-preview-text]").click({ clickCount: 3 })

      expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("Select this preview text")
    } finally {
      await browser.close()
    }
  })
})

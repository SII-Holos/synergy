import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { chromium, type Browser } from "playwright"

const css = await readFile(new URL("../../../src/components/settings/settings-panel.css", import.meta.url), "utf8")
let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

function fixture(content: string) {
  return `
    <style>
      *, ::before, ::after { box-sizing: border-box; }
      html, body { margin: 0; overflow: hidden; }
      .settings-panel-root { display: flex; width: calc(100vw - 16px); height: calc(100dvh - 16px); }
      .settings-panel-navigation { flex-shrink: 0; width: 224px; display: flex; flex-direction: column; overflow: hidden; }
      .settings-panel-content { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; }
      .settings-panel-body { flex: 1; min-height: 0; overflow-y: auto; }
      .settings-panel-footer { display: flex; align-items: center; gap: 8px; padding: 12px 24px; }
      button { height: 34px; }
      ${css}
    </style>
    ${content}
  `
}

describe("mobile Settings layout", () => {
  test("uses a full-width category list below the 768px breakpoint", async () => {
    const page = await browser.newPage({ viewport: { width: 767, height: 667 } })
    try {
      await page.setContent(
        fixture(`
          <div class="settings-panel-root">
            <nav class="settings-panel-navigation">
              <button class="settings-panel-category-action">General</button>
            </nav>
          </div>
        `),
      )
      const root = await page.locator(".settings-panel-root").boundingBox()
      const navigation = await page.locator(".settings-panel-navigation").boundingBox()
      const category = await page.locator(".settings-panel-category-action").boundingBox()
      expect(navigation?.width).toBe(root?.width)
      expect(category?.height).toBeGreaterThanOrEqual(44)
    } finally {
      await page.close()
    }
  })

  test("preserves the 224px desktop navigation at 768px", async () => {
    const page = await browser.newPage({ viewport: { width: 768, height: 667 } })
    try {
      await page.setContent(
        fixture(`
          <div class="settings-panel-root">
            <nav class="settings-panel-navigation"></nav>
            <main class="settings-panel-content"></main>
          </div>
        `),
      )
      const navigation = await page.locator(".settings-panel-navigation").boundingBox()
      expect(navigation?.width).toBe(224)
      expect(await page.locator(".settings-panel-content").count()).toBe(1)
    } finally {
      await page.close()
    }
  })

  test("keeps mobile detail navigation and footer actions reachable at 375px", async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
    try {
      await page.setContent(
        fixture(`
          <div class="settings-panel-root">
            <main class="settings-panel-content">
              <header class="settings-panel-mobile-detail-header">
                <button class="settings-panel-mobile-back">Back</button>
                <strong>General</strong>
              </header>
              <div class="settings-panel-body"><div style="height: 1200px"></div></div>
              <div class="ds-content-inner">Mobile content</div>
              <footer class="settings-panel-footer">
                <div class="settings-panel-footer-status">
                  <button class="settings-dev-toggle">Developer mode</button>
                </div>
                <div class="settings-panel-footer-actions">
                  <button>Cancel</button>
                  <button>Save Changes</button>
                </div>
              </footer>
            </main>
          </div>
        `),
      )

      const root = await page.locator(".settings-panel-root").boundingBox()
      const header = await page.locator(".settings-panel-mobile-detail-header").boundingBox()
      const back = await page.locator(".settings-panel-mobile-back").boundingBox()
      const footer = await page.locator(".settings-panel-footer").boundingBox()
      const actions = await page
        .locator(".settings-panel-footer-actions button")
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()))
      const body = page.locator(".settings-panel-body")
      const contentInner = page.locator(".ds-content-inner")

      expect(header?.width).toBe(root?.width)
      expect(back?.width).toBeGreaterThanOrEqual(44)
      expect(back?.height).toBeGreaterThanOrEqual(44)
      const rootRight = root!.x + root!.width
      expect(footer!.x + footer!.width).toBeLessThanOrEqual(rootRight)
      expect(actions.every((box) => box.height >= 44 && box.right <= rootRight)).toBe(true)
      expect(await contentInner.evaluate((element) => getComputedStyle(element).paddingLeft)).toBe("16px")
      expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
    } finally {
      await page.close()
    }
  })
})

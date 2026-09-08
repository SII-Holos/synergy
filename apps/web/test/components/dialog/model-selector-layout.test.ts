import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { chromium, type Browser } from "playwright"

const css = await readFile(new URL("../../../src/components/dialog/dialog-select-model.css", import.meta.url), "utf8")
let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

describe("model selector responsive layout", () => {
  test("fits the panel and footer within a 375px mobile viewport", async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
    try {
      await page.setContent(`
        <style>*, ::before, ::after { box-sizing: border-box; } ${css}</style>
        <div class="model-selector-popover">
          <div data-list style="flex: 1; min-height: 0; overflow: auto"><div style="height: 900px"></div></div>
          <footer data-footer>Model settings · Connect provider</footer>
        </div>
      `)

      const layout = await page.locator(".model-selector-popover").evaluate((element) => {
        const panel = element.getBoundingClientRect()
        const footer = element.querySelector("[data-footer]")?.getBoundingClientRect()
        const list = element.querySelector("[data-list]")
        if (!footer || !list) throw new Error("Expected model selector contents")
        return {
          panelLeft: panel.left,
          panelRight: panel.right,
          panelHeight: panel.height,
          footerBottom: footer.bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          panelOverflowY: getComputedStyle(element).overflowY,
          listOverflowY: getComputedStyle(list).overflowY,
          listClientHeight: list.clientHeight,
          listScrollHeight: list.scrollHeight,
        }
      })

      expect(layout.panelLeft).toBeGreaterThanOrEqual(0)
      expect(layout.panelRight).toBeLessThanOrEqual(layout.viewportWidth)
      expect(layout.panelHeight).toBeLessThanOrEqual(layout.viewportHeight - 32)
      expect(layout.footerBottom).toBeLessThanOrEqual(layout.viewportHeight)
      expect(layout.panelOverflowY).toBe("hidden")
      expect(layout.listOverflowY).toBe("auto")
      expect(layout.listScrollHeight).toBeGreaterThan(layout.listClientHeight)
    } finally {
      await page.close()
    }
  })

  test("keeps footer actions touch-sized through the 767px mobile breakpoint", async () => {
    const page = await browser.newPage({ viewport: { width: 700, height: 667 } })
    try {
      await page.setContent(`
        <style>*, ::before, ::after { box-sizing: border-box; } ${css}</style>
        <div class="model-selector-popover">
          <button class="model-selector-popover-footer-action" style="height: 28px">Model settings</button>
          <button class="model-selector-popover-footer-action" style="height: 28px">Connect provider</button>
        </div>
      `)
      const heights = await page
        .locator(".model-selector-popover-footer-action")
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
      expect(heights).toEqual([44, 44])
    } finally {
      await page.close()
    }
  })

  test("preserves the 28rem by 24rem desktop panel size", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    try {
      await page.setContent(`
        <style>*, ::before, ::after { box-sizing: border-box; } ${css}</style>
        <div class="model-selector-popover"></div>
      `)
      const box = await page.locator(".model-selector-popover").boundingBox()
      expect(box?.width).toBe(448)
      expect(box?.height).toBe(384)
    } finally {
      await page.close()
    }
  })
})

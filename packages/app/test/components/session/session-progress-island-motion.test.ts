import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"

const css = await readFile(
  new URL("../../../src/components/session/session-progress-island.css", import.meta.url),
  "utf8",
)
let browser: Browser

async function settleLayout(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

async function setExpanded(page: Page, expanded: boolean) {
  await page.evaluate((next) => {
    document.querySelector<HTMLElement>(".session-progress-island")!.dataset.expanded = String(next)
    document.querySelector<HTMLElement>(".session-progress-island-panel-wrap")!.dataset.expanded = String(next)
  }, expanded)
}

async function motionState(page: Page) {
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".session-progress-island-surface")!
    const panel = document.querySelector<HTMLElement>(".session-progress-island-panel")!
    return {
      surfaceWidth: surface.getBoundingClientRect().width,
      panelWidth: panel.offsetWidth,
      opacity: Number.parseFloat(getComputedStyle(panel).opacity),
    }
  })
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

describe("session progress island motion", () => {
  test("morphs the shell before revealing content and reverses that order when collapsing", async () => {
    const page = await browser.newPage({ viewport: { width: 760, height: 600 } })
    try {
      await page.setContent(`
        <style>
          *, ::before, ::after { box-sizing: border-box; }
          ${css}
          .session-progress-island-surface { animation: none !important; }
        </style>
        <div
          class="session-progress-island"
          data-expanded="false"
          data-collapsed-width="measured"
          data-tone="running"
        >
          <div class="session-progress-island-surface" style="--session-progress-island-collapsed-width: 282px">
            <button class="session-progress-island-header">
              <span class="session-progress-island-indicator"></span>
              <span class="session-progress-island-title">Implement DAG Island motion · 2/4</span>
              <span class="session-progress-island-chevron"></span>
            </button>
            <div class="session-progress-island-panel-wrap" data-expanded="false">
              <div class="session-progress-island-panel">
                <div class="session-progress-island-panel-topline">Current work</div>
                <div class="session-progress-island-body"></div>
              </div>
            </div>
          </div>
        </div>
      `)
      await settleLayout(page)

      const collapsed = await motionState(page)
      expect(collapsed.surfaceWidth).toBeCloseTo(282, 0)
      expect(collapsed.panelWidth).toBeGreaterThan(600)
      expect(collapsed.opacity).toBe(0)

      await setExpanded(page, true)
      await page.waitForTimeout(60)
      const opening = await motionState(page)
      expect(opening.surfaceWidth).toBeGreaterThan(collapsed.surfaceWidth + 10)
      expect(opening.panelWidth).toBeCloseTo(collapsed.panelWidth, 0)
      expect(opening.opacity).toBe(0)

      await page.waitForTimeout(420)
      const expanded = await motionState(page)
      expect(expanded.surfaceWidth).toBeGreaterThan(600)
      expect(expanded.panelWidth).toBeCloseTo(collapsed.panelWidth, 0)
      expect(expanded.opacity).toBe(1)

      await setExpanded(page, false)
      await page.waitForTimeout(45)
      const closing = await motionState(page)
      expect(closing.surfaceWidth).toBeGreaterThan(expanded.surfaceWidth - 5)
      expect(closing.panelWidth).toBeCloseTo(expanded.panelWidth, 0)
      expect(closing.opacity).toBeLessThan(0.9)

      await page.waitForTimeout(400)
      const closed = await motionState(page)
      expect(closed.surfaceWidth).toBeCloseTo(collapsed.surfaceWidth, 0)
      expect(closed.panelWidth).toBeCloseTo(expanded.panelWidth, 0)
      expect(closed.opacity).toBe(0)
    } finally {
      await page.close()
    }
  })

  test("keeps the measured compact shell inside a narrow viewport", async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 600 } })
    try {
      await page.setContent(`
        <style>
          *, ::before, ::after { box-sizing: border-box; }
          ${css}
          .session-progress-island-surface { animation: none !important; }
        </style>
        <div class="session-progress-island" data-expanded="false" data-collapsed-width="measured">
          <div class="session-progress-island-surface" style="--session-progress-island-collapsed-width: 620px">
            <button class="session-progress-island-header">
              <span class="session-progress-island-title">A compact label that is wider than the mobile viewport</span>
            </button>
            <div class="session-progress-island-panel-wrap" data-expanded="false">
              <div class="session-progress-island-panel"></div>
            </div>
          </div>
        </div>
      `)
      await settleLayout(page)

      const layout = await page.locator(".session-progress-island-surface").evaluate((surface) => ({
        left: surface.getBoundingClientRect().left,
        right: surface.getBoundingClientRect().right,
        width: surface.getBoundingClientRect().width,
      }))
      expect(layout.left).toBeGreaterThanOrEqual(12)
      expect(layout.right).toBeLessThanOrEqual(363)
      expect(layout.width).toBeLessThanOrEqual(351)
    } finally {
      await page.close()
    }
  })

  test("disables shell and content transitions when reduced motion is requested", async () => {
    const page = await browser.newPage({ viewport: { width: 760, height: 600 } })
    try {
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.setContent(`
        <style>${css}</style>
        <div class="session-progress-island" data-expanded="true" data-collapsed-width="measured">
          <div class="session-progress-island-surface" style="--session-progress-island-collapsed-width: 282px">
            <button class="session-progress-island-header"></button>
            <div class="session-progress-island-panel-wrap" data-expanded="true">
              <div class="session-progress-island-panel"></div>
            </div>
          </div>
        </div>
      `)

      const motion = await page.evaluate(() =>
        [
          ".session-progress-island-surface",
          ".session-progress-island-header",
          ".session-progress-island-panel-wrap",
          ".session-progress-island-panel",
        ].map((selector) => {
          const style = getComputedStyle(document.querySelector(selector)!)
          return { transitionDuration: style.transitionDuration, animationName: style.animationName }
        }),
      )
      expect(motion.every((item) => item.transitionDuration.split(", ").every((duration) => duration === "0s"))).toBe(
        true,
      )
      expect(motion[0]?.animationName).toBe("none")
    } finally {
      await page.close()
    }
  })
})

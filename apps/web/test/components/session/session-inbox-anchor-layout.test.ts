import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"

const inboxCss = await Bun.file(new URL("../../../src/components/session/session-inbox.css", import.meta.url)).text()

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser?.close()
})

async function mountComposerFixture(width: number, dockBand: number): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 600 } })
  await page.setContent(`
    <style>
      *, ::before, ::after { box-sizing: border-box; }
      ${inboxCss}
      body { margin: 0; font-family: sans-serif; }
    </style>
    <div
      data-dock
      style="position: relative; display: flex; flex-direction: column; padding-top: ${dockBand}px; width: 100%;"
    >
      <div data-wrap style="position: relative; width: 100%;">
        <div
          data-composer
          style="position: relative; z-index: 1; height: 90px; border-radius: 16px; background: #1b1b1d;"
        ></div>
        <div class="session-inbox-anchor">
          <button
            type="button"
            class="session-inbox-trigger statusbar-glass relative flex items-center justify-center rounded-full"
            style="width: 36px; height: 36px;"
          >
            inbox
          </button>
        </div>
      </div>
    </div>
  `)
  return page
}

async function readLayout(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>("[data-composer]")!.getBoundingClientRect()
    const anchor = document.querySelector<HTMLElement>(".session-inbox-anchor")!.getBoundingClientRect()
    return {
      composerTop: composer.top,
      composerBottom: composer.bottom,
      composerRight: composer.right,
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
      anchorLeft: anchor.left,
      anchorRight: anchor.right,
      viewportWidth: window.innerWidth,
    }
  })
}

describe("mobile session inbox trigger placement", () => {
  test("reserves no dock band and keeps the trigger clear above the composer", async () => {
    const page = await mountComposerFixture(390, 0)
    try {
      const layout = await readLayout(page)

      // The trigger keeps its original mobile offset (top: -2.875rem = 46px)
      // above the composer wrapper. Its 36 px height ends 10px above the
      // wrapper, so it never overlaps the composer's top edge; a lower offset
      // such as -1rem would dip the trigger onto the composer shell and fail
      // these bounds.
      expect(layout.composerTop - layout.anchorTop).toBeGreaterThanOrEqual(40)
      expect(layout.composerTop - layout.anchorTop).toBeLessThanOrEqual(52)
      expect(layout.anchorBottom).toBeLessThanOrEqual(layout.composerTop - 4)

      // Still fully inside the viewport horizontally (right: 0.75rem).
      expect(layout.anchorLeft).toBeGreaterThanOrEqual(8)
      expect(layout.anchorRight).toBeLessThanOrEqual(layout.viewportWidth - 8)
    } finally {
      await page.close()
    }
  })
})

describe("desktop session inbox trigger placement", () => {
  test("sits outboard to the right of the composer", async () => {
    const page = await mountComposerFixture(900, 0)
    try {
      const layout = await readLayout(page)

      // >= 48rem: anchored at 50% with right: -3rem, so the trigger is
      // vertically centered against the composer and outboard of its right
      // edge, not over the message column.
      expect(layout.anchorLeft).toBeGreaterThanOrEqual(layout.composerRight - 1)
      expect(layout.anchorLeft - layout.composerRight).toBeLessThanOrEqual(48)
      const anchorCenterY = (layout.anchorTop + layout.anchorBottom) / 2
      const composerCenterY = (layout.composerTop + layout.composerBottom) / 2
      expect(Math.abs(anchorCenterY - composerCenterY)).toBeLessThanOrEqual(40)
    } finally {
      await page.close()
    }
  })
})

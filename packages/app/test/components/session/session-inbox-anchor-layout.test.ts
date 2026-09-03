import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"

// The anchor floats relative to the `.relative` wrapper that also holds the
// composer shell (prompt-dock.tsx). The dock keeps its reserved 48 px top
// padding only on desktop (`md:pt-12`), so on mobile the inbox trigger must
// ride the composer's top edge instead of floating a full reserved-band height
// above it — that empty band used to read as a black strip that hid the last
// messages.
const css = await Bun.file(new URL("../../../src/components/session/session-inbox.css", import.meta.url)).text()

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser?.close()
})

async function mountDockFixture(width: number, dockPaddingTop: number): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 600 } })
  await page.setContent(`
    <style>
      *, ::before, ::after { box-sizing: border-box; }
      ${css}
      body { margin: 0; font-family: sans-serif; }
    </style>
    <div
      data-dock
      style="position: relative; display: flex; flex-direction: column; align-items: center; padding-top: ${dockPaddingTop}px; width: 100%;"
    >
      <div data-content class="session-prompt-dock-content w-full" style="padding: 0 12px;">
        <div data-wrap style="position: relative;">
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
    </div>
  `)
  return page
}

async function readLayout(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>("[data-composer]")!.getBoundingClientRect()
    const anchor = document.querySelector<HTMLElement>(".session-inbox-anchor")!.getBoundingClientRect()
    const dock = document.querySelector<HTMLElement>("[data-dock]")!
    return {
      composerTop: composer.top,
      composerBottom: composer.bottom,
      composerRight: composer.right,
      anchorTop: anchor.top,
      anchorBottom: anchor.bottom,
      anchorLeft: anchor.left,
      anchorRight: anchor.right,
      dockPaddingTop: getComputedStyle(dock).paddingTop,
      viewportWidth: window.innerWidth,
    }
  })
}

describe("mobile session inbox trigger placement", () => {
  test("rides the composer top edge instead of floating in a reserved band above it", async () => {
    // Mobile dock keeps no reserved top padding (prompt-dock.tsx applies
    // md:pt-12 only), mirroring that state with dockPaddingTop = 0.
    const page = await mountDockFixture(390, 0)
    try {
      const layout = await readLayout(page)

      expect(layout.dockPaddingTop).toBe("0px")

      // The trigger sits 1rem above the composer wrapper and its own 36 px
      // height dips 20 px onto the composer shell — it must hug the shell, not
      // hover a reserved-band height (46 px+) above it where it would overlay
      // the last messages.
      expect(layout.composerTop - layout.anchorTop).toBeGreaterThanOrEqual(12)
      expect(layout.composerTop - layout.anchorTop).toBeLessThanOrEqual(20)
      expect(layout.anchorBottom - layout.composerTop).toBeGreaterThanOrEqual(12)
      expect(layout.anchorBottom - layout.composerTop).toBeLessThanOrEqual(24)

      // Still fully inside the viewport horizontally (right: 0.75rem).
      expect(layout.anchorLeft).toBeGreaterThanOrEqual(8)
      expect(layout.anchorRight).toBeLessThanOrEqual(layout.viewportWidth - 8)
    } finally {
      await page.close()
    }
  })
})

describe("desktop session inbox trigger placement", () => {
  test("sits outboard to the right of the composer and keeps the dock top padding", async () => {
    // Desktop dock keeps its reserved pt-12 padding (md:pt-12), mirrored here.
    const page = await mountDockFixture(900, 48)
    try {
      const layout = await readLayout(page)

      expect(layout.dockPaddingTop).toBe("48px")

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

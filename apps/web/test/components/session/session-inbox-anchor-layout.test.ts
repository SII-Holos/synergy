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

async function mountComposerFixture(width: number, dockBand: number, latest?: { columnWidth: number }): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 600 } })
  await page.setContent(`
    <style>
      *, ::before, ::after { box-sizing: border-box; }
      ${inboxCss}
      body { margin: 0; font-family: sans-serif; }
    </style>
    <div style="width: ${latest?.columnWidth ?? width}px; ${latest ? "container-type: inline-size;" : ""}">
    <div
      data-dock
      style="position: relative; display: flex; flex-direction: column; padding-top: ${dockBand}px; width: 100%;"
    >
      <div data-wrap style="position: relative; width: 100%;">
        ${latest ? `<button data-latest style="position:absolute;top:-64px;right:${width < 768 ? 16 : 24}px;width:40px;height:40px;">Latest</button>` : ""}
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

      // Still fully inside the viewport horizontally.
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

test.each([
  [320, 320],
  [375, 375],
  [1440, 590],
])("a %i px viewport keeps the inbox clear of return-to-latest in a %i px column", async (width, columnWidth) => {
  const page = await mountComposerFixture(width, 80, { columnWidth })
  try {
    const layout = await page.evaluate(() => {
      const inbox = document.querySelector(".session-inbox-trigger")!.getBoundingClientRect()
      const latest = document.querySelector("[data-latest]")!.getBoundingClientRect()
      return {
        overlap:
          inbox.left < latest.right &&
          inbox.right > latest.left &&
          inbox.top < latest.bottom &&
          inbox.bottom > latest.top,
        gap: latest.left - inbox.right,
        inboxLeft: inbox.left,
      }
    })
    expect(layout.overlap).toBe(false)
    expect(layout.gap).toBeGreaterThanOrEqual(8)
    expect(layout.inboxLeft).toBeGreaterThanOrEqual(8)
  } finally {
    await page.close()
  }
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"

// The inbox trigger floats relative to the `.relative` wrapper that also holds
// the composer shell (prompt-dock.tsx). Its placement depends on two real
// layout decisions that fixed the mobile band:
//  1. PromptDock reserves its 48 px top band only at >= 48rem (`md:pt-12`) —
//     a bare `pt-12` recreates the empty dark strip above the composer.
//  2. The conversation keeps mobile bottom clearance (`pb-6`) so the floating
//     trigger never covers the last message.
// Reading those markers from the component sources keeps this suite from
// self-certifying: reverting either change fails the assertions below. The
// trigger geometry itself is then measured against the real session-inbox.css
// under both band states.
const inboxCss = await Bun.file(new URL("../../../src/components/session/session-inbox.css", import.meta.url)).text()

async function dockTopPaddingClass(): Promise<string> {
  const source = await Bun.file(new URL("../../../src/components/session/prompt-dock.tsx", import.meta.url)).text()
  const match = source.match(/"((?:md:)?pt-12)":\s*!props\.isNewSession\(\)/)
  if (!match) throw new Error("prompt-dock.tsx must declare the dock top padding class next to isNewSession")
  return match[1]!
}

async function conversationMobileClearance(): Promise<boolean> {
  const source = await Bun.file(new URL("../../../src/components/session/conversation.tsx", import.meta.url)).text()
  return source.includes('"pb-6 md:pb-[calc(var(--prompt-height,10rem)+96px)]"')
}

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
  test("reserves no dock band and rides the composer top edge", async () => {
    // The core regression: the dock must scope its 48 px reserved band to
    // >= 48rem. Reverting `md:pt-12` to the pre-fix `pt-12` fails here.
    const dockClass = await dockTopPaddingClass()
    expect(dockClass, "prompt-dock.tsx must scope pt-12 to md:").toBe("md:pt-12")
    expect(await conversationMobileClearance(), "conversation.tsx must keep mobile pb-6").toBe(true)

    const page = await mountComposerFixture(390, 0)
    try {
      const layout = await readLayout(page)

      // The trigger starts 1rem above the composer wrapper; its own 36 px
      // height dips ~20 px onto the composer shell. It must hug the shell, not
      // hover a reserved-band height above it where it would overlay the last
      // messages.
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
  test("keeps the dock band and sits outboard to the right of the composer", async () => {
    const dockClass = await dockTopPaddingClass()
    expect(dockClass).toBe("md:pt-12")

    const page = await mountComposerFixture(900, 48)
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

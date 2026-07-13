import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"

let browser: Browser | undefined
let page: Page
let markdownCss: string
let messagePartCss: string

beforeAll(async () => {
  ;[markdownCss, messagePartCss] = await Promise.all([
    Bun.file(new URL("../src/components/markdown.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/message-part.css", import.meta.url)).text(),
  ])
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
})

afterAll(async () => {
  await browser?.close()
})

describe("Markdown terminal transition layout", () => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`keeps timeline gaps stable with taller outgoing Markdown and ${reducedMotion} motion`, async () => {
      await page.emulateMedia({ reducedMotion })
      await page.setContent(`
        <style>
          :root {
            --font-family-sans: sans-serif;
            --font-size-base: 16px;
            --font-weight-medium: 500;
            --line-height-large: 1.5;
            --text-base: #111;
            --text-strong: #111;
            --markdown-heading: #111;
          }
          * { box-sizing: border-box; }
          body { margin: 0; }
          [data-slot="session-turn-timeline-item"] { width: 480px; }
          [data-slot="session-turn-timeline-item"] + [data-slot="session-turn-timeline-item"] { margin-top: 12px; }
          [data-component="tool-card-area"] { height: 32px; background: #ddd; }
          ${markdownCss}
        </style>
        <main>
          <div id="text-item" data-slot="session-turn-timeline-item" data-kind="text">
            <div data-component="markdown">
              <div data-slot="markdown-terminal-crossfade">
                <div data-slot="markdown-terminal-from">
                  <p>stream partial</p>
                  <p>stream parser still holds an intermediate block</p>
                  <p>outgoing content is deliberately taller</p>
                </div>
                <div data-slot="markdown-terminal-to"><p><strong>final</strong></p></div>
              </div>
            </div>
          </div>
          <div id="tool-item" data-slot="session-turn-timeline-item" data-kind="tool">
            <div data-component="tool-card-area"></div>
          </div>
        </main>
      `)

      const before = await measureGaps(page)
      await page.locator('[data-slot="markdown-terminal-crossfade"]').evaluate((stage) => {
        const terminal = stage.querySelector<HTMLElement>('[data-slot="markdown-terminal-to"]')
        if (!terminal) throw new Error("Expected terminal Markdown layer")
        stage.parentElement?.replaceChildren(...Array.from(terminal.childNodes))
      })
      const after = await measureGaps(page)

      expect(Math.abs(after.timeline - before.timeline)).toBeLessThanOrEqual(1)
      expect(Math.abs(after.visible - before.visible)).toBeLessThanOrEqual(1)
    })
  }

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

async function measureGaps(currentPage: Page) {
  return currentPage.evaluate(() => {
    const textItem = document.querySelector<HTMLElement>("#text-item")
    const toolItem = document.querySelector<HTMLElement>("#tool-item")
    const visibleText = document.querySelector<HTMLElement>(
      '[data-slot="markdown-terminal-to"] > :last-child, [data-component="markdown"] > :last-child',
    )
    const toolCard = document.querySelector<HTMLElement>('[data-component="tool-card-area"]')
    if (!textItem || !toolItem || !visibleText || !toolCard) throw new Error("Expected layout fixtures")

    const textItemRect = textItem.getBoundingClientRect()
    const toolItemRect = toolItem.getBoundingClientRect()
    const visibleTextRect = visibleText.getBoundingClientRect()
    const toolCardRect = toolCard.getBoundingClientRect()
    return {
      timeline: toolItemRect.top - textItemRect.bottom,
      visible: toolCardRect.top - visibleTextRect.bottom,
    }
  })
}

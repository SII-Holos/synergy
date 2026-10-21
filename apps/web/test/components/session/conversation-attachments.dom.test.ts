import { expect, test } from "bun:test"
import { errors, frames, page, url } from "../../support/conversation-process"

for (const width of [375, 1000]) {
  for (const theme of ["light", "dark"] as const) {
    for (const count of [1, 2]) {
      test(`${count} generated HTML documents align with conversation rows at ${width}px in ${theme}`, async () => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.goto(url)
        await page.getByText("I will check the project first.", { exact: true }).waitFor()
        await page.evaluate((count) => window.__conversationProcess.documents(count), count)
        const gallery = page.locator('[data-slot="activity-evidence"] [data-component="attachment-gallery"]')
        await gallery.waitFor()
        await page.locator('[data-slot="activity-step-trigger"]').waitFor()
        await frames()
        const geometry = await page.evaluate(() => {
          const bounds = (element: Element) => {
            const rect = element.getBoundingClientRect()
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width }
          }
          const gallery = document.querySelector(
            '[data-slot="activity-evidence"] [data-component="attachment-gallery"]',
          )!
          return {
            prose: bounds(document.querySelector('[data-part-id="progress"] [data-component="text-part"]')!),
            tool: bounds(document.querySelector('[data-slot="activity-step-trigger"]')!),
            gallery: bounds(gallery),
            cards: [...gallery.querySelectorAll('[data-component="attachment-card"]')].map(bounds),
            viewport: bounds(document.querySelector("[data-scroller]")!),
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          }
        })
        expect(geometry.cards).toHaveLength(count)
        expect(Math.abs(geometry.cards[0].left - geometry.prose.left)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.cards[0].left - geometry.tool.left)).toBeLessThanOrEqual(1)
        for (const card of geometry.cards) {
          expect(card.left).toBeGreaterThanOrEqual(geometry.viewport.left)
          expect(card.right).toBeLessThanOrEqual(geometry.viewport.right + 1)
        }
        if (count === 2) {
          if (width === 375) {
            expect(geometry.cards[1].left).toBe(geometry.cards[0].left)
            expect(geometry.cards[1].top).toBeGreaterThanOrEqual(geometry.cards[0].bottom)
          } else {
            expect(geometry.cards[1].top).toBe(geometry.cards[0].top)
            expect(geometry.cards[1].left).toBeGreaterThan(geometry.cards[0].right)
          }
        }
        expect(geometry.overflow).toBe(false)
        expect(await page.locator("html").getAttribute("data-color-scheme")).toBe(theme)
        const open = gallery.getByRole("button", { name: "Open content.html", exact: true })
        await open.focus()
        await open.press("Enter")
        expect(await page.evaluate(() => window.__processSelection)).toMatchObject({
          kind: "attachment",
          file: { filename: "content.html", url: "https://example.com/content.html" },
        })
        expect(errors).toEqual([])
      })
    }
  }
}

test("promoted tool deliveries retain their separate start-aligned gallery", async () => {
  await page.setViewportSize({ width: 1000, height: 900 })
  await page.goto(url)
  await page.getByText("I will check the project first.", { exact: true }).waitFor()
  await page.evaluate(() => window.__conversationProcess.documents(2, "deliverable"))
  const gallery = page.locator(
    '[data-slot="session-turn-timeline-item"][data-kind="tool-attachments"] [data-component="attachment-gallery"]',
  )
  await gallery.waitFor()
  await frames()
  expect(await page.locator('[data-slot="activity-evidence"]').count()).toBe(0)
  const prose = await page.locator('[data-part-id="progress"] [data-component="text-part"]').boundingBox()
  const card = await gallery.locator('[data-component="attachment-card"]').first().boundingBox()
  expect(Math.abs(card!.x - prose!.x)).toBeLessThanOrEqual(1)
  expect(await gallery.locator('[data-component="attachment-card"]').count()).toBe(2)
  expect(errors).toEqual([])
})

import { expect, test } from "bun:test"
import { errors, frames, page, url } from "../../support/conversation-process"

for (const theme of ["light", "dark"] as const) {
  for (const purpose of ["evidence", "deliverable"] as const) {
    test(`${theme}: ${purpose} tool images share left-aligned, uncropped thumbnails`, async () => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.goto(url)
      await page.getByText("I will check the project first.", { exact: true }).waitFor()
      await page.evaluate((purpose) => window.__conversationProcess.images(purpose), purpose)
      for (const width of [375, 1000]) {
        await page.setViewportSize({ width, height: 900 })
        const cards = page.locator('[data-component="attachment-card"][data-type="image"]')
        await cards.first().waitFor()
        const expand = page.getByRole("button", { name: /Expand/ })
        if (await expand.isVisible()) await expand.click()
        await frames()
        const bounds = await cards.evaluateAll((cards) =>
          cards.map((card) => {
            const image = card.querySelector("img")!
            const rect = card.getBoundingClientRect()
            const style = getComputedStyle(image)
            return {
              x: rect.x,
              width: rect.width,
              height: rect.height,
              imageX: image.getBoundingClientRect().x,
              fit: style.objectFit,
              position: style.objectPosition,
            }
          }),
        )
        expect(bounds).toHaveLength(3)
        const prose = await page.locator('[data-part-id="progress"] [data-component="text-part"]').boundingBox()
        expect(bounds[0]!.x).toBeCloseTo(prose!.x, 0)
        for (const card of bounds) {
          expect(card.width).toBe(160)
          expect(card.height).toBe(120)
          expect(card.imageX).toBe(card.x)
          expect(card.fit).toBe("contain")
          expect(card.position).toBe("0% 50%")
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
        ).toBe(false)
      }
      const first = page.locator('[data-component="attachment-card"]').first()
      await first.focus()
      await first.press("Enter")
      expect(await page.evaluate(() => window.__processSelection)).toMatchObject({
        kind: "attachment",
        file: { filename: "capture-0.svg" },
      })
      expect(errors).toEqual([])
    })
  }
}

for (const purpose of ["final", "media"] as const) {
  test(`${purpose} image deliveries retain large previews`, async () => {
    await page.setViewportSize({ width: 1000, height: 900 })
    await page.goto(url)
    await page.getByText("I will check the project first.", { exact: true }).waitFor()
    await page.evaluate((purpose) => window.__conversationProcess.images(purpose), purpose)
    const card = page.locator('[data-component="attachment-card"][data-type="image"]').first()
    await card.waitFor()
    await frames()
    expect(await card.getAttribute("data-compact")).toBeNull()
    expect((await card.boundingBox())!.width).toBeGreaterThan(160)
    expect(errors).toEqual([])
  })
}

for (const width of [260, 375, 1000]) {
  for (const theme of ["light", "dark"] as const) {
    for (const count of width === 260 ? [2] : [1, 2]) {
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
          const row = gallery.querySelector('[data-slot="attachment-row-layout"]')!
          const style = getComputedStyle(row)
          return {
            prose: bounds(document.querySelector('[data-part-id="progress"] [data-component="text-part"]')!),
            tool: bounds(document.querySelector('[data-slot="activity-step-trigger"]')!),
            gallery: bounds(gallery),
            cards: [...gallery.querySelectorAll('[data-component="attachment-card"]')].map(bounds),
            viewport: bounds(document.querySelector("[data-scroller]")!),
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            available: row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            gap: parseFloat(style.columnGap),
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
          const fits = geometry.cards[0].width + geometry.cards[1].width + geometry.gap <= geometry.available + 1
          if (!fits) {
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

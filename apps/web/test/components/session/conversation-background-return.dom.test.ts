import { expect, test } from "bun:test"
import { page, url, frames, errors } from "../../support/conversation-process"

for (const ended of [false, true]) {
  for (const delayed of [false, true]) {
    for (const reading of [false, true]) {
      test(`${delayed ? "delayed" : "cached"} background ${ended ? "completion" : "generation"} preserves ${reading ? "history reading" : "latest following"} on return`, async () => {
        await page.goto(`${url}?resident&scrolling&motion&content=background`)
        await page.waitForSelector("[data-scroller] [data-display-row]")
        await page.evaluate(() => {
          window.__conversationProcess.latest()
        })
        await frames()
        await page.waitForFunction(() => document.querySelector("[data-follow-motion]")?.getAnimations().length === 0)
        await page.waitForFunction(() => !document.querySelector("[data-markdown-pending]"))
        await frames()
        if (reading) {
          await page.locator("[data-scroller]").evaluate((el) => {
            el.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }))
            el.scrollTop = 100
            el.dispatchEvent(new Event("scroll"))
          })
          await frames()
        }
        const result = await page.evaluate(
          async ({ ended, reading, delayed }) => {
            const fixture = window.__conversationProcess
            const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
            const surface = viewport.querySelector<HTMLElement>("[data-follow-motion]")!
            const bounds = viewport.getBoundingClientRect()
            const anchor = [...viewport.querySelectorAll<HTMLElement>("[data-display-row] p")].find((el) => {
              const rect = el.getBoundingClientRect()
              return rect.top >= bounds.top && rect.bottom <= bounds.bottom
            })!
            const before = anchor.getBoundingClientRect().top
            const readsBefore = fixture.contentStats()
            fixture.select("peer")
            for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
            fixture.background(ended, delayed)
            for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
            const hiddenAnchor = anchor.isConnected
            const hiddenReads = fixture.contentStats()
            fixture.select("session")
            const samples = []
            for (let i = 0; i < 36; i++) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
              if (i === 8 && delayed) fixture.contentFinish("background-answer")
              const transform = getComputedStyle(surface).transform
              samples.push({
                offset: transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42,
                gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
                drift: reading ? anchor.getBoundingClientRect().top - before : 0,
                retained: viewport === document.querySelector("[data-scroller]") && (!reading || anchor.isConnected),
                visible: viewport.checkVisibility() && getComputedStyle(surface).opacity === "1",
              })
            }
            return {
              samples,
              hiddenAnchor,
              readsBefore,
              hiddenReads,
              readsAfter: fixture.contentStats(),
              answer: viewport.textContent?.includes("Background answer."),
            }
          },
          { ended, reading, delayed },
        )
        expect(result.hiddenReads).toEqual(result.readsBefore)
        for (const [id, count] of Object.entries(result.readsBefore)) expect(result.readsAfter[id], id).toBe(count)
        expect(result.hiddenAnchor).toBe(true)
        expect(result.samples.every((s) => s.retained && s.visible)).toBe(true)
        expect(Math.max(...result.samples.map((s) => Math.abs(s.offset)))).toBeLessThanOrEqual(1)
        if (reading) expect(Math.max(...result.samples.map((s) => Math.abs(s.drift)))).toBeLessThanOrEqual(1)
        else {
          expect(Math.max(...result.samples.map((s) => Math.abs(s.gap)))).toBeLessThanOrEqual(2)
          expect(result.answer).toBe(true)
        }
        expect(errors).toEqual([])
      }, 30000)
    }
  }
}

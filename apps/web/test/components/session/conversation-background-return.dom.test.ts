import { beforeEach, expect, test } from "bun:test"
import {
  page,
  url,
  frames,
  errors,
  browser,
  fixtureServer,
  observeResizeErrors,
} from "../../support/conversation-process"
import { testOptions } from "../../../script/test-options"

beforeEach(async () => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 })
})

for (const manual of [false, true]) {
  test(`${manual ? "manual disclosure" : "automatic collection"} interrupted by navigation is settled from the first return frame`, async () => {
    await page.goto(`${url}?resident&scrolling&motion&content=background`)
    await page.waitForSelector('[data-slot="process-virtualizer"] [data-slot="activity-step"]')
    await page.evaluate((manual) => {
      if (manual) window.__conversationProcess.mode("full")
      window.__conversationProcess.latest()
    }, manual)
    await page.waitForFunction(
      () => document.querySelector("[data-scroller]")?.getAttribute("data-hydrated") === "true",
    )
    const result = await page.evaluate(async (manual) => {
      const fixture = window.__conversationProcess
      const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
      const trigger = [...viewport.querySelectorAll<HTMLButtonElement>('[data-slot="activity-batch-trigger"]')].at(-1)!
      if (manual) trigger.click()
      else fixture.terminal()
      await Promise.resolve()
      const started = viewport.querySelectorAll("[data-motion-changing]").length
      fixture.select("peer")
      await settle()
      fixture.select("session")
      const samples = []
      for (let frame = 0; frame < 6; frame++) {
        await settle()
        samples.push({
          visible: viewport.checkVisibility(),
          changing: viewport.querySelectorAll("[data-motion-changing]").length,
          open: manual
            ? trigger.getAttribute("aria-expanded") === "true"
            : !!viewport.querySelector('[data-slot="turn-process-trigger"][aria-expanded="true"]'),
        })
      }
      return { started, samples }
    }, manual)
    expect(result.started).toBeGreaterThan(0)
    expect(result.samples).toEqual(Array.from({ length: 6 }, () => ({ visible: true, changing: 0, open: false })))
    expect(errors).toEqual([])
  }, 30000)
}

for (const ended of [false, true]) {
  test(
    `background message backlog returns with stable ${ended ? "collected history" : "latest tools"} before summary page validation finishes`,
    async () => {
      const cdp = await page.context().newCDPSession(page)
      await page.goto(`${url}?resident&scrolling&motion&content=background`)
      await page.waitForSelector('[data-slot="process-virtualizer"] [data-slot="activity-step"]')
      await page.evaluate(() => window.__conversationProcess.latest())
      await page.waitForFunction(
        () => document.querySelector("[data-scroller]")?.getAttribute("data-hydrated") === "true",
      )
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 })
      const result = await page.evaluate(async (ended) => {
        const fixture = window.__conversationProcess
        const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
        const before = fixture.contentStats()
        const hydrated = viewport.dataset.hydrated
        fixture.select("peer")
        await settle()
        if (ended) fixture.execution("running")
        fixture.backlog(24, ended)
        await settle()
        const hidden = fixture.contentStats()
        fixture.select("session")
        const samples = []
        for (let frame = 0; frame < 64; frame++) {
          if (frame >= 16 && frame < 40) fixture.backlogPage(frame - 16)
          if (frame === 48) fixture.execution()
          await settle()
          const open = viewport.querySelectorAll('[data-slot="activity-batch-trigger"][aria-expanded="true"]')
          const latest = viewport.querySelector<HTMLElement>(
            '[data-slot="activity-step"][data-part-id="backlog-23-tool-3"]',
          )
          const bounds = latest?.closest('[data-component="process-viewport"]')?.getBoundingClientRect()
          const rect = latest?.getBoundingClientRect()
          samples.push({
            open: open.length,
            rows: viewport.querySelectorAll("[data-display-row]").length,
            latest:
              !!rect && !!bounds && rect.height > 0 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1,
            gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
            moving: viewport.querySelectorAll("[data-motion-changing]").length,
            placeholders: [...viewport.querySelectorAll<HTMLElement>('[data-row-kind="load"]')]
              .filter((element) => element.dataset.messageId?.startsWith("backlog-"))
              .reduce((height, element) => height + element.getBoundingClientRect().height, 0),
          })
        }
        return {
          before,
          hydrated,
          hidden,
          samples,
          reads: fixture.contentStats(),
          answer: viewport.textContent?.includes("Background answer."),
        }
      }, ended)
      expect(result.hidden).toEqual(result.before)
      expect(result.hydrated).toBe("true")
      expect(
        result.samples.map((sample) => sample.open),
        JSON.stringify(result.samples.slice(0, 8)),
      ).toEqual(Array(64).fill(ended ? 0 : 1))
      expect(result.samples.every((sample) => sample.placeholders === 0)).toBe(true)
      expect(result.samples.every((sample) => sample.rows > 0)).toBe(true)
      expect(result.samples.every((sample) => sample.moving === 0 && Math.abs(sample.gap) <= 2)).toBe(true)
      if (ended) {
        expect(result.answer).toBe(true)
        expect(Object.keys(result.reads).filter((id) => id.startsWith("backlog-"))).toEqual([])
      } else {
        expect(result.samples.slice(8).every((sample) => sample.latest)).toBe(true)
        expect(Object.keys(result.reads).filter((id) => id.startsWith("backlog-")).length).toBeLessThan(40)
      }
      expect(errors).toEqual([])
    },
    testOptions.isolatedTimeoutMs,
  )
}

for (const completionFrame of [0, 1, 16]) {
  test(
    `a returned live backlog remains readable when it completes at frame ${completionFrame}`,
    async () => {
      const cdp = await page.context().newCDPSession(page)
      await page.goto(`${url}?resident&scrolling&motion&content=background`)
      await page.waitForSelector('[data-slot="process-virtualizer"] [data-slot="activity-step"]')
      await page.evaluate(() => window.__conversationProcess.latest())
      await page.waitForFunction(
        () => document.querySelector("[data-scroller]")?.getAttribute("data-hydrated") === "true",
      )
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 20 })
      const result = await page.evaluate(async (completionFrame) => {
        const fixture = window.__conversationProcess
        const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
        const before = fixture.contentStats()
        fixture.select("peer")
        await settle()
        fixture.backlog(24, false)
        await settle()
        const hidden = fixture.contentStats()
        fixture.select("session")
        const samples = []
        for (let frame = 0; frame < 96; frame++) {
          if (frame === completionFrame) fixture.background(true, false)
          await settle()
          const bounds = viewport.getBoundingClientRect()
          samples.push({
            rows: [...viewport.querySelectorAll<HTMLElement>("[data-display-row]")].filter((row) => {
              const rect = row.getBoundingClientRect()
              return row.checkVisibility() && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
            }).length,
            gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
          })
        }
        return { before, hidden, samples, answer: viewport.textContent?.includes("Background answer.") }
      }, completionFrame)
      expect(result.hidden).toEqual(result.before)
      expect(
        result.samples.every((sample) => sample.rows > 0),
        JSON.stringify(result.samples.slice(0, 24)),
      ).toBe(true)
      expect(result.samples.every((sample) => Math.abs(sample.gap) <= 2)).toBe(true)
      expect(result.answer).toBe(true)
      expect(errors).toEqual([])
    },
    testOptions.isolatedTimeoutMs,
  )
}

for (const ended of [false, true]) {
  test(`background ${ended ? "completed" : "running"} message backlog preserves an inner reading anchor while bodies and pages settle`, async () => {
    await page.goto(`${url}?resident&scrolling&motion&content=background`)
    await page.waitForSelector('[data-slot="process-virtualizer"] [data-slot="activity-step"]')
    await page.evaluate(() => window.__conversationProcess.latest())
    await frames()
    const result = await page.evaluate(async (ended) => {
      const fixture = window.__conversationProcess
      const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const outer = document.querySelector<HTMLElement>("[data-scroller]")!
      const viewport = outer
        .querySelector('[data-part-id="many-2"][data-slot="activity-step"]')!
        .closest<HTMLElement>('[data-component="process-viewport"]')!
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }))
      viewport.scrollTop = 50
      viewport.dispatchEvent(new Event("scroll"))
      for (let i = 0; i < 8; i++) await settle()
      const anchor = [...viewport.querySelectorAll<HTMLElement>('[data-slot="activity-step"]')].find((element) => {
        const rect = element.getBoundingClientRect(),
          bounds = viewport.getBoundingClientRect()
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom
      })!
      const before = anchor.getBoundingClientRect().top
      const reads = fixture.contentStats()
      fixture.select("peer")
      await settle()
      fixture.backlog(24, ended, true)
      await settle()
      const hidden = fixture.contentStats()
      fixture.select("session")
      const samples = []
      for (let frame = 0; frame < 48; frame++) {
        if (frame >= 8 && frame < 32) fixture.backlogPage(frame - 8)
        if (frame === 24)
          for (let i = 0; i < 24; i++)
            for (let part = 0; part < 4; part++) fixture.contentFinish(`backlog-${i}-tool-${part}`)
        await settle()
        samples.push({
          retained: anchor.isConnected,
          drift: anchor.getBoundingClientRect().top - before,
          same: viewport.isConnected && viewport.checkVisibility(),
          offset: viewport.scrollTop,
        })
      }
      return { reads, hidden, samples, after: fixture.contentStats() }
    }, ended)
    expect(result.hidden).toEqual(result.reads)
    expect(result.samples.every((sample) => sample.retained && sample.same && Math.abs(sample.drift) <= 1)).toBe(true)
    for (const [id, count] of Object.entries(result.reads)) expect(result.after[id], id).toBe(count)
    expect(errors).toEqual([])
  }, 30000)
}

for (const ended of [false, true])
  for (const reading of [false, true]) {
    test(`retained ${ended ? "completed" : "running"} tool windows keep their nodes and ${reading ? "reading anchor" : "latest position"} across background growth and width changes`, async () => {
      await page.goto(`${url}?resident&scrolling&motion&content=background`)
      await page.waitForSelector('[data-slot="process-virtualizer"] [data-slot="activity-step"]')
      await page.evaluate(() => {
        window.__conversationProcess.mode("full")
        window.__conversationProcess.latest()
      })
      await frames()
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-follow-motion], [data-slot="process-viewport-motion"]')].every(
          (element) => element.getAnimations().length === 0,
        ),
      )
      const result = await page.evaluate(
        async ({ reading, ended }) => {
          const fixture = window.__conversationProcess
          const settle = async (count = 5) => {
            for (let i = 0; i < count; i++)
              await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
          }
          const outer = document.querySelector<HTMLElement>("[data-scroller]")!
          const viewport = outer
            .querySelector('[data-slot="activity-step"][data-part-id^="many-"]')!
            .closest<HTMLElement>('[data-component="process-viewport"]')!
          const virtual = viewport.querySelector<HTMLElement>('[data-slot="process-virtualizer"]')!
          if (reading) {
            viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }))
            viewport.scrollTop = 80
            viewport.dispatchEvent(new Event("scroll"))
          }
          await settle()
          const bounds = viewport.getBoundingClientRect()
          const tool = [...virtual.querySelectorAll<HTMLElement>('[data-slot="activity-step"]')].find((element) => {
            const rect = element.getBoundingClientRect()
            return rect.top >= bounds.top && rect.bottom <= bounds.bottom
          })!
          const offset = tool.getBoundingClientRect().top - bounds.top
          const before = fixture.contentStats()
          const hidden = []
          const samples = []
          for (const [index, width] of ["480px", "900px", "700px"].entries()) {
            fixture.select("peer")
            outer.style.width = width
            await settle()
            fixture.grow(16 + index * 4)
            if (ended) fixture.terminal()
            await settle()
            hidden.push({ virtual: virtual.isConnected, tool: tool.isConnected, reads: fixture.contentStats() })
            fixture.select("session")
            for (let i = 0; i < 20; i++) {
              await settle(1)
              const motion = viewport.querySelector<HTMLElement>('[data-slot="process-viewport-motion"]')!
              const transform = getComputedStyle(motion).transform
              samples.push({
                retained: virtual.isConnected && (!reading || tool.isConnected),
                rows: virtual.querySelectorAll("[data-display-row]").length,
                drift: reading ? tool.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset : 0,
                gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
                offset: transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42,
              })
            }
          }
          return { before, hidden, samples, after: fixture.contentStats() }
        },
        { reading, ended },
      )
      expect(result.hidden.every((sample) => sample.virtual && (!reading || sample.tool))).toBe(true)
      expect(result.hidden[0].tool).toBe(true)
      expect(result.samples.every((sample) => sample.retained && sample.rows > 0)).toBe(true)
      expect(Math.max(...result.samples.map((sample) => Math.abs(sample.offset)))).toBeLessThanOrEqual(1)
      if (reading) expect(Math.max(...result.samples.map((sample) => Math.abs(sample.drift)))).toBeLessThanOrEqual(1)
      else expect(Math.max(...result.samples.map((sample) => Math.abs(sample.gap)))).toBeLessThanOrEqual(2)
      for (const [id, count] of Object.entries(result.before)) expect(result.after[id], id).toBe(count)
      expect(result.hidden[0].reads).toEqual(result.before)
      expect(errors).toEqual([])
    }, 30000)
  }

test("background completion applies automatic process collection without replaying collapse on return", async () => {
  await page.goto(`${url}?resident&scrolling&motion&content=background`)
  await page.waitForSelector('[data-slot="process-virtualizer"] [data-slot="activity-step"]')
  await frames()
  const samples = await page.evaluate(async () => {
    const fixture = window.__conversationProcess
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    fixture.latest()
    for (let i = 0; i < 30; i++) await settle()
    fixture.select("peer")
    await settle()
    fixture.terminal()
    await settle()
    fixture.select("session")
    const viewport = document.querySelector<HTMLElement>("[data-scroller]")!
    const samples = []
    for (let i = 0; i < 30; i++) {
      await settle()
      samples.push({
        changing: viewport.querySelectorAll("[data-motion-changing]").length,
        parent: viewport.querySelector('[data-slot="turn-process-trigger"]')?.getAttribute("aria-expanded"),
        gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        visible: viewport.checkVisibility(),
      })
    }
    return samples
  })
  expect(
    samples.every(
      (sample) => sample.parent === "false" && sample.changing === 0 && sample.visible && Math.abs(sample.gap) <= 2,
    ),
  ).toBe(true)
  expect(errors).toEqual([])
})

for (const ended of [false, true]) {
  for (const delayed of [false, true]) {
    for (const reading of [false, true]) {
      for (const entry of (ended && delayed ? ["index.mjs", "index.jsx"] : ["index.mjs"]) as (
        "index.mjs" | "index.jsx"
      )[]) {
        test(`${delayed ? "delayed" : "cached"} background ${ended ? "completion" : "generation"} preserves ${reading ? "history reading" : "latest following"} on return (${entry})`, async () => {
          const alternate = entry === "index.jsx" ? await fixtureServer(entry) : undefined
          const target = alternate ? await browser.newPage() : page
          if (alternate) {
            await observeResizeErrors(target)
            target.on("pageerror", (error) => errors.push(error.message))
            const cdp = await target.context().newCDPSession(target)
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 })
          }
          try {
            await target.goto(`${alternate?.url ?? url}?resident&scrolling&motion&content=background`)
            await target.waitForSelector("[data-scroller] [data-display-row]")
            await target.evaluate(() => {
              window.__conversationProcess.latest()
            })
            await target.evaluate(async () => {
              for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame)
            })
            await target.waitForFunction(
              () => document.querySelector("[data-follow-motion]")?.getAnimations().length === 0,
            )
            await target.waitForFunction(() => !document.querySelector("[data-markdown-pending]"))
            await target.evaluate(async () => {
              for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame)
            })
            if (reading) {
              await target.locator("[data-scroller]").evaluate((el) => {
                el.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }))
                el.scrollTop = 100
                el.dispatchEvent(new Event("scroll"))
              })
              await target.waitForFunction(() => {
                if (document.querySelector("[data-markdown-pending]")) return false
                const rows = [...document.querySelectorAll<HTMLElement>("[data-scroller] [data-display-row]")]
                  .filter((el) => !el.closest('[data-component="process-window"]'))
                  .map((el) => el.getBoundingClientRect())
                  .filter((rect) => rect.height > 0)
                  .sort((a, b) => a.top - b.top)
                return rows.every((rect, i) => i === 0 || rect.top >= rows[i - 1].bottom - 1)
              })
              await frames(target)
            }
            const result = await target.evaluate(
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
                const probe = document.createElement("div")
                probe.style.cssText =
                  "position:fixed;left:-100px;top:0;width:1px;height:1px;visibility:hidden;contain:strict"
                document.body.append(probe)
                let onLayout: (() => void) | undefined
                const observer = new ResizeObserver(() => {
                  const ready = onLayout
                  onLayout = undefined
                  ready?.()
                })
                observer.observe(probe)
                try {
                  for (let i = 0; i < 36; i++) {
                    await new Promise<void>((resolve) =>
                      requestAnimationFrame(() => {
                        onLayout = resolve
                        probe.style.width = `${2 - (i % 2)}px`
                      }),
                    )
                    if (i === 8 && delayed) fixture.contentFinish("background-answer")
                    const transform = getComputedStyle(surface).transform
                    samples.push({
                      frame: i,
                      hydrated: viewport.dataset.hydrated,
                      pending: viewport.querySelectorAll("[data-content-pending], [data-markdown-pending]").length,
                      offset: transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42,
                      gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
                      drift: reading ? anchor.getBoundingClientRect().top - before : 0,
                      retained:
                        viewport === document.querySelector("[data-scroller]") && (!reading || anchor.isConnected),
                      visible: viewport.checkVisibility() && getComputedStyle(surface).opacity === "1",
                    })
                  }
                } finally {
                  observer.disconnect()
                  probe.remove()
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
            expect(result.samples.filter((sample) => !sample.retained || !sample.visible)).toEqual([])
            expect(
              result.samples.filter((sample) => Math.abs(sample.offset) > 1),
              JSON.stringify(result.samples),
            ).toEqual([])
            if (reading) expect(Math.max(...result.samples.map((s) => Math.abs(s.drift)))).toBeLessThanOrEqual(1)
            else {
              expect(
                Math.max(...result.samples.map((s) => Math.abs(s.gap))),
                JSON.stringify(result.samples),
              ).toBeLessThanOrEqual(2)
              expect(result.answer).toBe(true)
              if (delayed) {
                expect(result.samples.slice(0, 8).every((sample) => sample.hydrated === "false")).toBe(true)
                expect(result.readsAfter["background-answer"]).toBe(1)
              }
            }
            expect(errors).toEqual([])
          } finally {
            if (alternate) {
              await target.close()
              await alternate.close()
            }
          }
        }, 30000)
      }
    }
  }
}

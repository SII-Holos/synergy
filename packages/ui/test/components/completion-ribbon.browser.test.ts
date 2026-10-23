import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { domFixture } from "../support/dom-fixtures"

type Fixture = {
  live(): void
  finish(status?: "completed" | "failed" | "stopped" | "interrupted"): void
  setReady(value: boolean): void
  setActive(value: boolean): void
  setFollowing(value: boolean): void
  remount(): void
  unmount(): void
  opened(): number
  retheme(): void
  setSummary(value?: { status: "completed" | "running"; elapsedMs: number }): void
  clearReply(): void
}
declare global {
  interface Window {
    completionRibbonFixture: Fixture
  }
}

let server: ReturnType<typeof Bun.serve>
let browser: Browser
let page: Page
const errors: string[] = []
const overlay = '[data-component="completion-ribbon-overlay"]'
const signature = '[data-component="completion-ribbon"]'

beforeAll(async () => {
  const directory = path.dirname(fileURLToPath(await domFixture("completion-ribbon.dom")))
  const styles = [...new Bun.Glob("*.css").scanSync({ cwd: directory })]
    .map((file) => `<link rel="stylesheet" href="/${file}">`)
    .join("")
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/")
        return new Response(
          `<!doctype html><head>${styles}<style>body { margin: 24px; font: 16px/1.5 sans-serif; } #root { width: 350px; } * { box-sizing: border-box; }</style></head><body><div id="root"></div><script>globalThis.process = { env: { NODE_ENV: "test" } }</script><script type="module" src="/completion-ribbon.dom.js"></script></body>`,
          { headers: { "content-type": "text/html" } },
        )
      return new Response(Bun.file(path.join(directory, pathname)))
    },
  })
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  server?.stop(true)
})

async function open(segmented = false, list = false) {
  await page?.close()
  page = await browser.newPage({ viewport: { width: 480, height: 680 } })
  page.on("pageerror", (error) => errors.push(error.message))
  const query = new URLSearchParams()
  if (segmented) query.set("segmented", "")
  if (list) query.set("list", "")
  await page.goto(`${server.url.href}?${query}`)
  await page.waitForFunction(() => !!window.completionRibbonFixture)
  await page.locator('[data-component="markdown"] p').last().waitFor()
  await page.clock.install()
}

for (const segmented of [false, true])
  test(`a live completion flows from the last Markdown line without gating footer actions (${segmented ? "segmented" : "whole"})`, async () => {
    await open(segmented)
    await page.evaluate(() => window.completionRibbonFixture.live())
    await page.clock.runFor(32)
    const before = await page.evaluate(() => {
      window.completionRibbonFixture.finish()
      const viewport = document.querySelector<HTMLElement>("[data-conversation-viewport]")!
      const copy = document.querySelector<HTMLButtonElement>('[data-slot="assistant-message-copy"]')!
      copy.focus()
      return { height: viewport.scrollHeight, scroll: viewport.scrollTop, text: document.body.textContent }
    })
    expect(before.text).toContain("Completed")
    expect(await page.locator('[data-slot="assistant-message-copy"]').isEnabled()).toBe(true)
    await page.clock.runFor(180)
    expect(await page.locator(overlay).count()).toBe(1)
    const frame = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-component="completion-ribbon-overlay"]')!
      const context = canvas.getContext("2d")!
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const viewport = document.querySelector<HTMLElement>("[data-conversation-viewport]")!
      const rect = canvas.getBoundingClientRect()
      const ink: { x: number; y: number }[] = []
      const scale = canvas.width / rect.width
      for (let offset = 3; offset < pixels.length; offset += 4)
        if (pixels[offset] > 24) {
          const pixel = (offset - 3) / 4
          ink.push({
            x: rect.left + (pixel % canvas.width) / scale,
            y: rect.top + Math.floor(pixel / canvas.width) / scale,
          })
        }
      const last = document.querySelector('[data-component="markdown"] p:last-child')!.lastChild!
      const range = document.createRange()
      range.selectNodeContents(last)
      const line = [...range.getClientRects()].at(-1)!
      return {
        ink: ink.length,
        originDistance: Math.min(
          ...ink.map((point) => Math.hypot(point.x - line.right, point.y - (line.top + line.height / 2))),
        ),
        outside: !viewport.contains(canvas),
        pointerEvents: getComputedStyle(canvas).pointerEvents,
        hidden: canvas.getAttribute("aria-hidden"),
        focus: document.activeElement?.getAttribute("data-slot"),
        height: viewport.scrollHeight,
        scroll: viewport.scrollTop,
      }
    })
    expect(frame.ink).toBeGreaterThan(0)
    expect(frame.originDistance).toBeLessThan(25)
    expect(frame.outside).toBe(true)
    expect(frame.pointerEvents).toBe("none")
    expect(frame.hidden).toBe("true")
    expect(frame.focus).toBe("assistant-message-copy")
    expect(frame.height).toBe(before.height)
    expect(frame.scroll).toBe(before.scroll)
    await page.locator('[data-component="execution-completion"] button').click()
    expect(await page.evaluate(() => window.completionRibbonFixture.opened())).toBe(1)
    await page.clock.runFor(3000)
    expect(await page.locator(overlay).count()).toBe(0)
    expect(await page.locator(signature).evaluate((element) => element.getBoundingClientRect().width)).toBe(16)
    await page.evaluate(() => window.completionRibbonFixture.remount())
    await page.clock.runFor(64)
    expect(await page.locator(overlay).count()).toBe(0)
    expect(await page.locator(signature).count()).toBe(1)
  })

for (const mode of ["history", "reconnect", "background", "reading", "reduced"] as const)
  test(`${mode} completion settles statically and cannot replay after admission`, async () => {
    await open(true)
    if (mode === "reduced") await page.emulateMedia({ reducedMotion: "reduce" })
    await page.evaluate((mode) => {
      const fixture = window.completionRibbonFixture
      if (mode !== "history") fixture.live()
      if (mode === "reconnect") fixture.setReady(false)
      if (mode === "background") fixture.setActive(false)
      if (mode === "reading") fixture.setFollowing(false)
      fixture.finish()
    }, mode)
    await page.clock.runFor(64)
    expect(await page.locator(overlay).count()).toBe(0)
    expect(await page.locator(signature).count()).toBe(1)
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.evaluate(() => {
      const fixture = window.completionRibbonFixture
      fixture.setActive(true)
      fixture.setReady(true)
      fixture.setFollowing(true)
    })
    await page.clock.runFor(64)
    expect(await page.locator(overlay).count()).toBe(0)
    await page.evaluate(() => window.completionRibbonFixture.remount())
    await page.clock.runFor(64)
    expect(await page.locator(overlay).count()).toBe(0)
  })

for (const status of ["failed", "stopped", "interrupted"] as const)
  test(`${status} does not acquire a success signature`, async () => {
    await open(true)
    await page.evaluate((status) => {
      window.completionRibbonFixture.live()
      window.completionRibbonFixture.finish(status)
    }, status)
    await page.clock.runFor(64)
    expect(await page.locator(signature).count()).toBe(0)
    expect(await page.locator(overlay).count()).toBe(0)
  })

for (const stop of ["hidden", "inactive", "unmount", "reduced", "readiness"] as const)
  test(`${stop} terminates an in-flight ribbon without replay`, async () => {
    await open(true)
    await page.evaluate(() => {
      window.completionRibbonFixture.live()
      window.completionRibbonFixture.finish()
    })
    await page.clock.runFor(160)
    expect(await page.locator(overlay).count()).toBe(1)
    if (stop === "reduced") await page.emulateMedia({ reducedMotion: "reduce" })
    else
      await page.evaluate((stop) => {
        const fixture = window.completionRibbonFixture
        if (stop === "hidden") {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
          document.dispatchEvent(new Event("visibilitychange"))
        }
        if (stop === "inactive") fixture.setActive(false)
        if (stop === "readiness") fixture.setReady(false)
        if (stop === "unmount") fixture.unmount()
      }, stop)
    await page.clock.runFor(32)
    expect(await page.locator(overlay).count()).toBe(0)
    if (stop !== "unmount") {
      expect(await page.locator(signature).count()).toBe(1)
      await page.emulateMedia({ reducedMotion: "no-preference" })
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
        document.dispatchEvent(new Event("visibilitychange"))
        window.completionRibbonFixture.setActive(true)
        window.completionRibbonFixture.setReady(true)
      })
      await page.clock.runFor(64)
      expect(await page.locator(overlay).count()).toBe(0)
    }
  })

test("a same-mode theme change recolors the folded ribbon without restarting it", async () => {
  await open(true)
  await page.evaluate(() => {
    window.completionRibbonFixture.live()
    window.completionRibbonFixture.finish()
  })
  await page.clock.runFor(1900)
  const before = await page.locator(overlay).evaluate((element) => (element as HTMLCanvasElement).toDataURL())
  await page.evaluate(() => window.completionRibbonFixture.retheme())
  await page.clock.runFor(32)
  expect(await page.locator(overlay).evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(before)
  await page.clock.runFor(1000)
  expect(await page.locator(overlay).count()).toBe(0)
  expect(await page.locator(signature).count()).toBe(1)
})

test("late accounting updates preserve a settled signature without replay", async () => {
  await open(true)
  await page.evaluate(() => window.completionRibbonFixture.finish())
  await page.clock.runFor(64)
  await page.locator('[data-component="execution-completion"] button').focus()
  const result = await page.evaluate(() => {
    const mark = document.querySelector('[data-component="completion-ribbon"]')
    const button = document.activeElement
    window.completionRibbonFixture.setSummary({ status: "running", elapsedMs: 20_000 })
    window.completionRibbonFixture.setSummary({ status: "completed", elapsedMs: 25_000 })
    return {
      same: mark === document.querySelector('[data-component="completion-ribbon"]'),
      focused: button === document.activeElement,
      text: document.body.textContent,
    }
  })
  expect(result.same).toBe(true)
  expect(result.focused).toBe(true)
  expect(result.text).toContain("00:25")
  await page.clock.runFor(64)
  expect(await page.locator(overlay).count()).toBe(0)
})

test("stopped foreground work cannot inherit a stale accounting success signature", async () => {
  await open(true)
  await page.evaluate(() => {
    window.completionRibbonFixture.live()
    window.completionRibbonFixture.setSummary({ status: "completed", elapsedMs: 20_000 })
    window.completionRibbonFixture.finish("stopped")
  })
  await page.clock.runFor(64)
  expect(await page.locator(signature).count()).toBe(0)
  expect(await page.locator(overlay).count()).toBe(0)
})

test("a footer without a mounted answer remains immediately complete with a static signature", async () => {
  await open(true)
  await page.evaluate(() => {
    window.completionRibbonFixture.live()
    window.completionRibbonFixture.clearReply()
    window.completionRibbonFixture.finish()
  })
  await page.clock.runFor(64)
  expect(await page.locator(overlay).count()).toBe(0)
  expect(await page.locator(signature).isVisible()).toBe(true)
  expect(await page.locator('[data-component="execution-completion"]').textContent()).toContain("Completed")
})

test("the travelling ribbon paints theme-colored pixels rather than normalized near-black channels", async () => {
  await open(true)
  await page.evaluate(() => {
    window.completionRibbonFixture.live()
    window.completionRibbonFixture.finish()
  })
  await page.clock.runFor(1250)
  expect(await page.locator(overlay).count()).toBe(1)
  const colored = await page.locator(overlay).evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
    let colored = 0
    for (let offset = 0; offset < pixels.length; offset += 4)
      if (
        pixels[offset + 3] > 32 &&
        Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) -
          Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) >
          20
      )
        colored++
    return colored
  })
  expect(colored).toBeGreaterThan(10)
})

for (const spacing of [0, 32])
  test(`the folded mark and docking ribbon avoid list text and controls without reserving height (${spacing}px extra gap)`, async () => {
    await open(true, true)
    await page.addStyleTag({ content: `[data-segment-footer] { margin-block-start: ${spacing}px; }` })
    await page.locator('[data-component="markdown"] li').last().waitFor()
    await page.evaluate(() => {
      window.completionRibbonFixture.live()
      window.completionRibbonFixture.finish()
    })
    const height = await page.locator("[data-conversation-viewport]").evaluate((element) => element.scrollHeight)
    let elapsed = 0
    for (const advance of [400, 850, 850, 400]) {
      await page.clock.runFor(advance)
      elapsed += advance
      expect(await page.locator(overlay).count()).toBe(1)
      const result = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-component="completion-ribbon-overlay"]')!
        const rectangles: DOMRect[] = []
        const walker = document.createTreeWalker(
          document.querySelector("[data-completion-reply]")!,
          NodeFilter.SHOW_TEXT,
        )
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue
          const range = document.createRange()
          range.selectNodeContents(walker.currentNode)
          rectangles.push(...range.getClientRects())
        }
        for (const element of document.querySelectorAll(
          '[data-component="execution-completion"] span, [data-component="execution-completion"] button, [data-slot="assistant-message-meta"]',
        ))
          rectangles.push(element.getBoundingClientRect())
        const rect = canvas.getBoundingClientRect()
        const ratio = canvas.width / rect.width
        const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data
        let overlap = 0
        let ink = 0
        let top = Infinity
        let bottom = -Infinity
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset + 3] <= 32) continue
          ink++
          const pixel = offset / 4
          const horizontal = rect.left + (pixel % canvas.width) / ratio
          const vertical = rect.top + Math.floor(pixel / canvas.width) / ratio
          top = Math.min(top, vertical)
          bottom = Math.max(bottom, vertical)
          if (
            rectangles.some(
              (occupied) =>
                horizontal >= occupied.left &&
                horizontal <= occupied.right &&
                vertical >= occupied.top &&
                vertical <= occupied.bottom,
            )
          )
            overlap++
        }
        const seal = document.querySelector('[data-component="completion-ribbon"]')!.getBoundingClientRect()
        return {
          overlap,
          ink,
          drop: seal.top + seal.height / 2 - (top + bottom) / 2,
          signatureHeight: seal.height,
          height: document.querySelector("[data-conversation-viewport]")!.scrollHeight,
        }
      })
      expect(result.ink).toBeGreaterThan(10)
      expect(result.overlap).toBe(0)
      expect(result.height).toBe(height)
      if (elapsed === 2100) {
        expect(result.drop).toBeGreaterThanOrEqual(0)
        expect(result.drop).toBeLessThanOrEqual(result.signatureHeight / 2)
      }
    }
  })

test("completion ribbon fixtures have no uncaught errors", () => expect(errors).toEqual([]))

import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { domFixture } from "../support/dom-fixtures"

type Harness = {
  move: (stage: number) => void
  reset: () => void
  setProgress: (text: string) => void
  send: () => void
  remount: () => void
  fastTool: () => void
  setFollowing: (following: boolean) => void
}
let server: ReturnType<typeof Bun.serve>
let browser: Browser
let page: Page
const warnings: string[] = []
beforeAll(async () => {
  const directory = path.dirname(fileURLToPath(await domFixture("session-turn-chronology.dom")))
  const iconCss = await Bun.file(path.resolve(import.meta.dir, "../../src/components/icon.css")).text()
  const styles = [...new Bun.Glob("*.css").scanSync({ cwd: directory })]
    .map((file) => `<link rel="stylesheet" href="/${file}">`)
    .join("")
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname === "/")
        return new Response(
          `<!doctype html><head>${styles}<style>${iconCss}
:root { --motion-duration-base: 180ms; --motion-duration-slow: 240ms; --motion-ease-standard: cubic-bezier(.2,0,0,1); --font-family-sans: sans-serif; --text-base: #202020; --text-weak: #666; --font-size-small: 14px; --line-height-large: 1.5; } body { margin: 16px; font: 16px/1.5 sans-serif } * { box-sizing: border-box }</style></head><body><div id="root"></div><script>globalThis.process = { env: { NODE_ENV: "test" } }</script><script type="module" src="/session-turn-chronology.dom.js"></script></body>`,
          { headers: { "content-type": "text/html" } },
        )
      return new Response(Bun.file(path.join(directory, pathname)))
    },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 900 } })
  page.on("console", (message) => {
    if (message.text().includes("created outside")) warnings.push(message.text())
  })
  page.on("pageerror", (error) => console.error(error))
  await page.goto(server.url.href)
  await page.waitForFunction(() => !!(window as unknown as { __chronologyHarness: Harness }).__chronologyHarness)
  await page.locator('[data-slot="turn-process-trigger"]').waitFor()
}, 60000)
afterAll(async () => {
  await browser?.close()
  server?.stop(true)
})
const move = (stage: number) =>
  page.evaluate(
    (stage) => (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness.move(stage),
    stage,
  )
const settled = () => page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 300)))

test("waiting hands over in one stable metadata row and streaming prose never fades out on settlement", async () => {
  await page.evaluate(() => {
    const node = document.querySelector('[data-slot="turn-process-trigger"]')
    ;(window as unknown as { metadataNode: Element | null }).metadataNode = node
  })
  await move(1)
  expect(
    await page.evaluate(
      () =>
        document.querySelector('[data-slot="turn-process-trigger"]') ===
        (window as unknown as { metadataNode: Element }).metadataNode,
    ),
  ).toBe(true)
  expect(await page.locator('[data-slot="turn-process-meta"] [data-component="process-reasoning"]').count()).toBe(0)
  await move(3)
  await settled()
  const frames = await page.evaluate(async () => {
    const harness = (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness
    const prose = document.querySelector('[data-component="text-part"] [data-component="markdown"]')!
    const paragraph = prose.querySelector("p")
    harness.move(4)
    const result: { opacity: number; duplicate: boolean; waiting: boolean; sameParagraph: boolean }[] = []
    for (let frame = 0; frame < 18; frame++) {
      await new Promise(requestAnimationFrame)
      result.push({
        opacity: Number(getComputedStyle(prose).opacity),
        duplicate: !!prose.querySelector('[data-slot="markdown-terminal-crossfade"]'),
        waiting: !!document.querySelector('[data-component="provider-prelude"]'),
        sameParagraph: prose.querySelector("p") === paragraph,
      })
    }
    return result
  })
  for (const frame of frames) {
    expect(frame.opacity).toBe(1)
    expect(frame.duplicate).toBe(false)
    expect(frame.waiting).toBe(false)
    expect(frame.sameParagraph).toBe(true)
  }
})

test("collection animates outward while restored reasoning has no entrance", async () => {
  await move(3)
  await settled()
  const frames = await page.evaluate(async () => {
    const harness = (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness
    const old = document.querySelector<HTMLElement>('[data-part-id="tool-1"]')!
    harness.move(5)
    const result: { old: number; next: number; hidden: boolean }[] = []
    const start = performance.now()
    while (performance.now() - start < 320) {
      await new Promise(requestAnimationFrame)
      result.push({
        old: old.getBoundingClientRect().height,
        next: document.querySelector('[data-slot="activity-reasoning"]')?.getBoundingClientRect().height ?? 0,
        hidden: old.hidden,
      })
    }
    return result
  })
  expect(frames.some((frame) => frame.old > 0 && frame.old < 27)).toBe(true)
  expect(frames.some((frame) => frame.next > 0 && frame.next < 27)).toBe(false)
  expect(Math.max(...frames.map((frame) => frame.old + frame.next))).toBeLessThanOrEqual(60)
  expect(frames.at(-1)?.hidden).toBe(true)
  expect(frames.at(-1)?.next).toBeGreaterThanOrEqual(28)
})

test("a manual reveal can interrupt collection without stale hiding or repeated stream animations", async () => {
  await move(3)
  await settled()
  await move(5)
  await page.locator('[data-slot="activity-batch-trigger"]').click()
  await settled()
  expect(await page.locator('[data-part-id="tool-1"]').isVisible()).toBe(true)
  await move(6)
  const prose = page.locator('[data-component="text-part"]')
  await page.evaluate(() =>
    (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness.setProgress(
      "I will inspect the project evidence. Additional streamed text.",
    ),
  )
  await settled()
  expect(await prose.locator('[data-slot="markdown-terminal-crossfade"]').count()).toBe(0)
  expect(await page.locator('[data-slot="activity-batch-trigger"]').getAttribute("aria-expanded")).toBe("true")
  expect(warnings).toEqual([])
})

test("a submitted bubble enters once and a remounted message stays settled", async () => {
  await move(0)
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness
    harness.send()
    const bubble = document.querySelector<HTMLElement>('[data-slot="session-turn-rewind-wrapper"]')!
    const animation = bubble.getAnimations()[0]
    animation?.pause()
    if (animation) animation.currentTime = 90
    const opacity = Number(getComputedStyle(bubble).opacity)
    const transform = getComputedStyle(bubble).transform
    animation?.finish()
    await new Promise(requestAnimationFrame)
    harness.remount()
    return {
      opacity,
      transform,
      replay: document.querySelector('[data-slot="session-turn-rewind-wrapper"]')!.getAnimations().length,
    }
  })
  expect(result.opacity).toBeGreaterThan(0)
  expect(result.opacity).toBeLessThan(1)
  expect(result.transform).not.toBe("none")
  expect(result.replay).toBe(0)
})

test("new stream suffixes fade without changing preceding text or paragraph identity", async () => {
  await move(2)
  await settled()
  const result = await page.evaluate(() => {
    const harness = (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness
    const markdown = document.querySelector('[data-component="text-part"] [data-component="markdown"]')!
    const paragraph = markdown.querySelector("p")!
    const old = paragraph.firstChild
    harness.setProgress("I will inspect the project evidence. 新增内容 **keeps formatting**. ")
    const spans = [...markdown.querySelectorAll<HTMLElement>("[data-stream-arrival]")]
    for (const span of spans)
      for (const animation of span.getAnimations()) {
        animation.pause()
        animation.currentTime = 100
      }
    return {
      same: markdown.querySelector("p") === paragraph && paragraph.firstChild === old,
      opacity: getComputedStyle(paragraph).opacity,
      arrivals: spans.map((span) => Number(getComputedStyle(span).opacity)),
      text: markdown.textContent,
    }
  })
  expect(result.same).toBe(true)
  expect(result.opacity).toBe("1")
  expect(result.arrivals.length).toBeGreaterThan(0)
  expect(result.arrivals.every((opacity) => opacity > 0 && opacity < 1)).toBe(true)
  expect(result.text).toContain("新增内容 keeps formatting")
  await page.evaluate(() =>
    document.getAnimations().forEach((animation) => {
      if (animation.playState === "paused") animation.finish()
    }),
  )
})

test("a tool first received completed still enters while following", async () => {
  await move(3)
  await settled()
  const result = await page.evaluate(() => {
    const harness = (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness
    harness.fastTool()
    const tool = document.querySelector<HTMLElement>('[data-part-id="tool-fast"]')!
    const animation = tool.getAnimations()[0]
    animation?.pause()
    if (animation) animation.currentTime = 90
    return {
      animated: !!animation,
      height: tool.getBoundingClientRect().height,
      opacity: Number(getComputedStyle(tool).opacity),
    }
  })
  expect(result.animated).toBe(true)
  expect(result.height).toBeGreaterThan(0)
  expect(result.opacity).toBeLessThan(1)
})

test("narrow and reduced-motion presentation stays readable and settles immediately", async () => {
  await page.setViewportSize({ width: 320, height: 600 })
  await move(2)
  await page.evaluate(() => {
    const harness = (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness
    harness.setProgress("I will inspect the project evidence. Preference changes during streaming. ")
    for (const span of document.querySelectorAll("[data-stream-arrival]"))
      for (const animation of span.getAnimations()) animation.pause()
  })
  expect(await page.locator("[data-stream-arrival]").count()).toBeGreaterThan(0)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.waitForFunction(() => !document.querySelector("[data-stream-arrival]"))
  await page.evaluate(() => {
    const harness = (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness
    harness.send()
    harness.setProgress("I will inspect the project evidence. Reduced motion suffix. ")
  })
  expect(await page.locator("[data-message-arrival], [data-stream-arrival]").count()).toBe(0)
  await page.evaluate(() => (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness.reset())
  await move(3)
  await move(6)
  expect(await page.evaluate(() => document.querySelector<HTMLElement>('[data-part-id="tool-1"]')?.hidden)).toBe(true)
  expect(
    await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (animation) =>
              (animation.effect as KeyframeEffect)?.target instanceof Element &&
              ((animation.effect as KeyframeEffect).target as Element).closest(
                '[data-component="activity-batch"], [data-component="process-reasoning"]',
              ),
          ).length,
    ),
  ).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
})

test("detached reading suppresses spatial arrivals and consumes a submitted entrance", async () => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  const result = await page.evaluate(() => {
    const harness = (window as unknown as { __chronologyHarness: Harness }).__chronologyHarness
    harness.setFollowing(false)
    harness.send()
    harness.move(3)
    harness.fastTool()
    const tool = document.querySelector('[data-part-id="tool-fast"]')!
    const arrival = document.querySelector("[data-message-arrival]")
    const animations = tool.getAnimations().length
    harness.setFollowing(true)
    harness.remount()
    return { animations, arrival: !!arrival, replay: !!document.querySelector("[data-message-arrival]") }
  })
  expect(result).toEqual({ animations: 0, arrival: false, replay: false })
})

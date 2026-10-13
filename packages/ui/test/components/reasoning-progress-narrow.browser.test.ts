import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"

// JSDOM has no layout engine, so the width ownership of the new reasoning
// progress groups is verified in a real browser at phone and desktop widths.
let browser: Browser
let page: Page
let css: string

const LONG_SUFFIX =
  "Continuingtoemitunpunctuatedreasoningsuffixwithoutanydelimiterforalongstretchoftherowtoexerciseoverflow"

beforeAll(async () => {
  css = (
    await Promise.all(
      [
        "activity-batch",
        "activity-trace",
        "animated-activity-count",
        "collapsible",
        "compact-reasoning",
        "icon",
        "session-turn",
        "spinner",
      ].map((name) => Bun.file(path.resolve(import.meta.dir, `../../src/components/${name}.css`)).text()),
    )
  ).join("\n")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 900 } })
}, 60000)

afterAll(async () => {
  await browser?.close()
})

const countMarkup = (value: string) =>
  `<span data-component="animated-activity-count"><span data-slot="activity-count-grid" aria-hidden="true"><span data-slot="activity-count-new">${value}</span></span></span>`

const standardRow = (label: string, value: string, unit: string) =>
  `<div data-component="process-reasoning"><button type="button" data-slot="process-reasoning-trigger" aria-expanded="false"><svg data-component="icon" width="16" height="16"></svg><span data-slot="process-reasoning-status"><span data-slot="process-reasoning-label">${label}</span><span data-slot="process-reasoning-progress">${countMarkup(value)}<span data-slot="process-reasoning-progress-unit">${unit}</span></span></span><svg data-component="icon" width="16" height="16"></svg></button></div>`

const compactRow = (label: string, value: string, unit: string) =>
  `<div data-component="compact-reasoning" data-state="running"><span data-slot="compact-reasoning-leading" aria-hidden="true"><svg data-component="spinner" width="12" height="12"></svg></span><span data-slot="compact-reasoning-label">${label}</span><span data-slot="compact-reasoning-progress">${countMarkup(value)}<span data-slot="compact-reasoning-progress-unit">${unit}</span></span><span data-slot="compact-reasoning-scroller"><span data-slot="compact-reasoning-text">${LONG_SUFFIX}</span></span></div>`

async function mount(width: number) {
  await page.setViewportSize({ width, height: 900 })
  // Mirrors the real conversation structure: the timeline column owns the
  // width and each timeline item is a 100%-width child of it.
  await page.setContent(`<style>
    :root { --text-base: rgb(29 29 29); --text-weak: rgb(79 79 79); --text-subtle: rgb(102 102 102); --icon-weak-base: rgb(79 79 79); --border-weaker-base: rgb(220 220 220); --font-family-sans: sans-serif; --font-size-small: 14px; --radius-full: 9999px; --motion-duration-fast: 120ms; --motion-duration-base: 180ms; --motion-duration-slow: 240ms; --motion-ease-standard: ease; }
    * { box-sizing: border-box; } body { margin: 16px; font: 14px/20px sans-serif; }
    ${css}
  </style>
  <div data-component="session-turn">
    <div data-slot="session-turn-timeline">
      <div data-slot="session-turn-timeline-item" data-kind="reasoning" id="standard">${standardRow("Thinking", "1,234", "generated words")}</div>
      <div data-slot="session-turn-timeline-item" data-kind="reasoning" id="compact">${compactRow("Thinking", "1,234", "generated words")}</div>
    </div>
  </div>`)
}

function metrics(selector: string) {
  return page.locator(selector).evaluate((root) => {
    const progress = root.querySelector('[data-slot$="-progress"]')!
    const label = root.querySelector('[data-slot$="-label"]')!
    const count = root.querySelector('[data-component="animated-activity-count"]')!
    const scroller = root.querySelector('[data-slot="compact-reasoning-scroller"]')
    const rowBox = root.getBoundingClientRect()
    const progressBox = progress.getBoundingClientRect()
    const labelBox = label.getBoundingClientRect()
    const countBox = count.getBoundingClientRect()
    return {
      rowLeft: rowBox.left,
      rowRight: rowBox.right,
      rowWidth: rowBox.width,
      rowScrollWidth: root.scrollWidth,
      progressLeft: progressBox.left,
      progressRight: progressBox.right,
      progressWidth: progressBox.width,
      labelRight: labelBox.right,
      countWidth: countBox.width,
      scrollerWidth: scroller?.getBoundingClientRect().width ?? null,
      scrollerClientWidth: scroller?.clientWidth ?? null,
      scrollerScrollWidth: scroller?.scrollWidth ?? null,
      documentScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }
  })
}

test("standard reasoning progress stays inside the row at phone and desktop widths", async () => {
  for (const width of [375, 800]) {
    await mount(width)
    const m = await metrics("#standard [data-component='process-reasoning']")
    expect(m.countWidth).toBeGreaterThan(0)
    expect(m.progressWidth).toBeGreaterThan(0)
    // The group sits after the label and never escapes the row's own box.
    expect(m.labelRight).toBeLessThanOrEqual(m.progressLeft + 1)
    expect(m.progressLeft).toBeGreaterThanOrEqual(m.rowLeft - 1)
    expect(m.progressRight).toBeLessThanOrEqual(m.rowRight + 1)
    expect(m.rowScrollWidth).toBeLessThanOrEqual(Math.ceil(m.rowWidth) + 1)
    expect(m.documentScrollWidth).toBeLessThanOrEqual(m.innerWidth + 1)
  }
})

test("compact reasoning progress keeps the scroller's width ownership", async () => {
  for (const width of [375, 800]) {
    await mount(width)
    const m = await metrics("#compact [data-component='compact-reasoning']")
    expect(m.countWidth).toBeGreaterThan(0)
    expect(m.progressWidth).toBeGreaterThan(0)
    expect(m.labelRight).toBeLessThanOrEqual(m.progressLeft + 1)
    expect(m.progressRight).toBeLessThanOrEqual(m.rowRight + 1)
    expect(m.rowScrollWidth).toBeLessThanOrEqual(Math.ceil(m.rowWidth) + 1)
    expect(m.documentScrollWidth).toBeLessThanOrEqual(m.innerWidth + 1)
    // The scroller keeps the remaining width and overflows internally
    // instead of pushing the row wider.
    expect(m.scrollerWidth!).toBeGreaterThan(0)
    expect(m.scrollerClientWidth!).toBeLessThan(m.scrollerScrollWidth!)
  }
})

test("compact progress stays bounded and leaves the suffix readable at phone width", async () => {
  await mount(375)
  const m = await metrics("#compact [data-component='compact-reasoning']")
  expect(m.progressWidth).toBeLessThan(m.rowWidth / 2)
  expect(m.scrollerWidth!).toBeGreaterThan(m.rowWidth / 3)
})

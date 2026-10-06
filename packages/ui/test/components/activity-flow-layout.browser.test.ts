import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"

let browser: Browser
let page: Page
let css: string

beforeAll(async () => {
  css = (
    await Promise.all(
      ["collapsible", "session-turn", "activity-batch", "activity-trace", "markdown"].map((name) =>
        Bun.file(path.resolve(import.meta.dir, `../../src/components/${name}.css`)).text(),
      ),
    )
  ).join("\n")
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
})

afterAll(async () => {
  await browser?.close()
})

async function mount(width = 800) {
  await page.setViewportSize({ width, height: 900 })
  const row = (index: number) =>
    `<li data-slot="activity-step"><button type="button" data-slot="activity-step-trigger" aria-pressed="${index === 0}"><span data-slot="activity-step-icon"><svg data-component="icon" width="16" height="16"></svg></span><span data-slot="activity-step-copy"><span data-slot="activity-step-title">Read README.md to check the project instructions ${index + 1}</span></span></button></li>`
  const trace = (start: number, count: number) =>
    `<div data-component="activity-trace"><ol data-slot="activity-step-list">${Array.from({ length: count }, (_, index) => row(start + index)).join("")}</ol></div>`
  const batch = (start: number, count: number) =>
    `<div data-slot="session-turn-timeline-item" data-kind="activity-batch"><div data-component="activity-batch"><button data-slot="activity-batch-trigger" aria-expanded="true"><span>Read ${count} files</span><svg data-component="icon" width="16" height="16"></svg></button>${trace(start, count)}</div></div>`
  await page.setContent(`<style>
    :root { --text-base: rgb(29 29 29); --border-focus: rgb(40 90 180); --text-weak: rgb(79 79 79); --icon-base: rgb(29 29 29); --icon-weak-base: rgb(79 79 79); --surface-base-hover: rgb(238 238 238); --font-family-sans: sans-serif; --font-weight-regular: 400; --font-weight-medium: 500; --font-weight-semibold: 600; --motion-duration-fast: 120ms; --motion-duration-base: 180ms; --motion-duration-slow: 240ms; --motion-ease-standard: ease; }
    * { box-sizing: border-box; } body { margin: 16px; font: 14px/20px sans-serif; } p { margin: 0; }
    ${css}
  </style><div data-component="session-turn"><div data-slot="session-turn-timeline">
    <div data-slot="turn-process-meta"><button data-slot="turn-process-trigger">Worked for 20 seconds</button></div><div data-slot="session-turn-timeline-item" data-kind="activity-reasoning-summary"><div data-component="process-reasoning"><button data-slot="process-reasoning-trigger">View reasoning</button><div data-slot="process-reasoning-detail" hidden>Stored reasoning</div></div></div>
    <div data-slot="session-turn-timeline-item" data-kind="text"><p>Check the project instructions, then inspect the related files.</p></div>
    ${batch(0, 3)}
    <div data-slot="session-turn-timeline-item" data-kind="activity-group">${trace(3, 1)}</div>
    <div data-slot="session-turn-timeline-item" data-kind="reasoning" hidden>Hidden intermediate reasoning</div>
    ${batch(4, 16)}
    <div data-slot="session-turn-timeline-item" data-kind="text"><p>The checks are complete. The project instructions and file contents agree.</p></div>
  </div></div>`)
}

test("twenty tools and an object boundary use one compact reading rhythm", async () => {
  await mount()
  const metrics = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-slot="activity-step-trigger"]')).map((row) =>
      row.getBoundingClientRect(),
    )
    const standalone = rows[3]
    const previous = rows[2]
    const batch = document.querySelector<HTMLElement>('[data-kind="activity-batch"]')!
    const next = document.querySelector<HTMLElement>('[data-kind="activity-group"]')!
    const heading = document.querySelector<HTMLElement>('[data-slot="turn-process-trigger"]')!
    const reasoning = document.querySelector<HTMLElement>('[data-slot="process-reasoning-trigger"]')!
    return {
      count: rows.length,
      rowHeights: rows.map((row) => row.height),
      toolGap: standalone.top - previous.bottom,
      blockGap: next.getBoundingClientRect().top - batch.getBoundingClientRect().bottom,
      reasoningOutsideMetadata: !reasoning.closest('[data-slot="turn-process-meta"]'),
      reasoningAfterHeading: reasoning.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom,
      reasoningBeforeProse:
        reasoning.getBoundingClientRect().bottom <=
        document.querySelector('[data-kind="text"]')!.getBoundingClientRect().top,
    }
  })
  expect(metrics.count).toBe(20)
  expect(Math.max(...metrics.rowHeights)).toBe(32)
  expect(Math.min(...metrics.rowHeights)).toBe(32)
  expect(metrics.toolGap).toBeLessThanOrEqual(8)
  expect(metrics.blockGap).toBeLessThanOrEqual(8)
  expect(metrics.reasoningOutsideMetadata).toBe(true)
  expect(metrics.reasoningAfterHeading).toBe(true)
  expect(metrics.reasoningBeforeProse).toBe(true)
})

test("batch disclosure arrows stay beside their label at wide and narrow widths", async () => {
  for (const width of [800, 320]) {
    await mount(width)
    const gaps = await page.locator('[data-slot="activity-batch-trigger"]').evaluateAll((buttons) =>
      buttons.map((button) => {
        const label = button.querySelector("span")!
        const arrow = button.querySelector("svg")!
        return arrow.getBoundingClientRect().left - label.getBoundingClientRect().right
      }),
    )
    for (const gap of gaps) expect(gap).toBe(8)
  }
})

test("selection emphasizes text without retaining a hover surface", async () => {
  await mount()
  await page.mouse.move(0, 0)
  const row = page.locator('[data-slot="activity-step-trigger"][aria-pressed="true"]')
  expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
  const title = row.locator('[data-slot="activity-step-title"]')
  expect(await title.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(29, 29, 29)")
  expect(await title.evaluate((element) => Number(getComputedStyle(element).fontWeight))).toBeGreaterThanOrEqual(500)
  await row.hover()
  expect(await row.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
})

test("keyboard focus remains distinct from selection and hover", async () => {
  await mount()
  await page.locator('[data-slot="turn-process-trigger"]').focus()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  const row = page.locator('[data-slot="activity-step-trigger"]').first()
  const focus = await row.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      active: document.activeElement === element,
      visible: element.matches(":focus-visible"),
      outline: parseFloat(style.outlineWidth),
      background: style.backgroundColor,
    }
  })
  expect(focus.active).toBe(true)
  expect(focus.visible).toBe(true)
  expect(focus.outline).toBeGreaterThanOrEqual(2)
  expect(focus.background).toBe("rgba(0, 0, 0, 0)")
})

test.each([320, 375])("wrapped tool intentions stay aligned and readable at %ipx", async (width) => {
  await mount(width)
  const metrics = await page.locator('[data-slot="activity-step-trigger"]').evaluateAll((rows) =>
    rows.map((row) => {
      const title = row.querySelector<HTMLElement>('[data-slot="activity-step-title"]')!
      const icon = row.querySelector<HTMLElement>('[data-slot="activity-step-icon"]')!
      return {
        overflow: row.scrollWidth - row.clientWidth,
        titleOverflow: title.scrollWidth - title.clientWidth,
        aligned: Math.abs(title.getBoundingClientRect().top - icon.getBoundingClientRect().top),
        height: row.getBoundingClientRect().height,
      }
    }),
  )
  for (const metric of metrics) {
    expect(metric.overflow).toBeLessThanOrEqual(1)
    expect(metric.titleOverflow).toBeLessThanOrEqual(1)
    expect(metric.aligned).toBeLessThanOrEqual(1)
    expect(metric.height).toBeGreaterThanOrEqual(24)
  }
})

test("compact failed rows retain accessible status without a visible badge", async () => {
  await mount(375)
  const row = page.locator('[data-slot="activity-step-trigger"]').first()
  await row.evaluate((element) => {
    element.setAttribute("aria-label", `${element.textContent!.trim()} · Failed`)
  })
  expect(await page.getByRole("button", { name: /instructions 1 · Failed$/ }).count()).toBe(1)
  expect(await row.locator('[data-slot="activity-state"]').count()).toBe(0)
  const size = await row.evaluate((element) => ({ overflow: element.scrollWidth - element.clientWidth }))
  expect(size.overflow).toBeLessThanOrEqual(1)
})

test("answer typography uses readable prose and restrained semantic emphasis", async () => {
  await mount()
  await page
    .locator('[data-kind="text"]')
    .last()
    .evaluate((element) => {
      element.innerHTML =
        '<div data-component="markdown"><p>Checks are complete.</p><h2>Verified result</h2><p>The files agree. <strong>No changes were made.</strong></p></div>'
    })
  const metrics = await page.locator('[data-component="markdown"]').evaluate((element) => {
    const paragraph = getComputedStyle(element.querySelector("p")!)
    const heading = getComputedStyle(element.querySelector("h2")!)
    const strong = getComputedStyle(element.querySelector("strong")!)
    return {
      fontSize: getComputedStyle(element).fontSize,
      lineHeight: getComputedStyle(element).lineHeight,
      paragraphGap: parseFloat(paragraph.marginBottom),
      headingBorder: parseFloat(heading.borderLeftWidth),
      strongWeight: Number(strong.fontWeight),
    }
  })
  expect(metrics.fontSize).toBe("16px")
  expect(parseFloat(metrics.lineHeight)).toBeGreaterThanOrEqual(24)
  expect(metrics.paragraphGap).toBeLessThanOrEqual(12)
  expect(metrics.headingBorder).toBe(0)
  expect(metrics.strongWeight).toBeGreaterThanOrEqual(600)
})

test("an answer starting with a heading uses only the timeline's leading gap", async () => {
  await mount()
  await page
    .locator('[data-kind="text"]')
    .last()
    .evaluate((element) => {
      element.innerHTML = '<div data-component="markdown"><h2>Verified result</h2><p>No changes were made.</p></div>'
    })
  const metrics = await page
    .locator('[data-kind="text"]')
    .last()
    .evaluate((element) => {
      const heading = element.querySelector("h2")!
      return {
        headingMargin: parseFloat(getComputedStyle(heading).marginTop),
        gap: heading.getBoundingClientRect().top - element.previousElementSibling!.getBoundingClientRect().bottom,
      }
    })
  expect(metrics.headingMargin).toBe(0)
  expect(metrics.gap).toBe(8)
})

test("collected history occupies no row space and only current activity carries waiting motion", async () => {
  await mount(375)
  const rows = page.locator('[data-slot="activity-step"]')
  await rows.evaluateAll((elements) => {
    elements.forEach((element, index) => {
      element.toggleAttribute("hidden", index !== elements.length - 1)
      if (index === elements.length - 1) {
        element.setAttribute("data-current", "")
        element.setAttribute("data-working", "")
      }
    })
  })
  const metrics = await rows.evaluateAll((elements) =>
    elements.map((element) => ({
      height: element.getBoundingClientRect().height,
      motion: getComputedStyle(element.querySelector('[data-slot="activity-step-title"]')!).animationName,
    })),
  )
  expect(metrics.slice(0, -1).every((metric) => metric.height === 0 && metric.motion === "none")).toBe(true)
  expect(metrics.at(-1)!.height).toBeGreaterThanOrEqual(28)
  expect(metrics.at(-1)!.motion).not.toBe("none")
  await page.emulateMedia({ reducedMotion: "reduce" })
  const current = rows.last().locator('[data-slot="activity-step-title"]')
  expect(await current.evaluate((element) => getComputedStyle(element).animationName)).toBe("none")
  expect(await current.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s")
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

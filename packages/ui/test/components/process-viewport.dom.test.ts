import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import type { FixtureHarness } from "../fixtures/process-viewport.dom"

type FixtureWindow = Window & { processViewportFixture: FixtureHarness }
let directory: string
let server: ViteDevServer
let browser: Browser
let page: Page
const diagnostics: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".process-viewport-"))
  const fixture = path.resolve(import.meta.dir, "../fixtures/process-viewport.dom.tsx")
  await Bun.write(path.join(directory, "main.tsx"), `import ${JSON.stringify(fixture)}`)
  await Bun.write(
    path.join(directory, "index.html"),
    `<!doctype html><html><head><style>
      body { margin: 16px; font: 16px/24px sans-serif; }
      #root { width: 560px; }
      [data-slot="process-virtualizer"] { position: relative; }
      [data-slot="activity-step"] { padding-block: 8px; }
      p { margin: 0; }
      button { font: inherit; }
    </style></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>`,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    logLevel: "error",
    plugins: [solid()],
    resolve: {
      alias: {
        "@ericsanchezok/synergy-plugin/icons": path.resolve(import.meta.dir, "../../../plugin/src/icons.ts"),
      },
    },
    optimizeDeps: {
      include: [
        "solid-js",
        "solid-js/web",
        "solid-js/jsx-runtime",
        "zod",
        "@lingui/core",
        "@lingui/solid",
        "lucide-solid",
      ],
      noDiscovery: true,
    },
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: null,
      fs: { allow: [path.resolve(import.meta.dir, "../../../.."), directory] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 60_000)

async function load(
  mode: "instrumented" | "local" = "instrumented",
  classification: "consumer" | "default" = "consumer",
) {
  await page.goto(`${server.resolvedUrls!.local[0]}?mode=${mode}&classification=${classification}`, {
    waitUntil: "domcontentloaded",
  })
  await page
    .waitForFunction(() => !!(window as unknown as FixtureWindow).processViewportFixture)
    .catch((cause) => {
      throw new Error(`ProcessViewport fixture failed to load: ${diagnostics.join("\n")}`, { cause })
    })
  await page.evaluate(() => (window as unknown as FixtureWindow).processViewportFixture.positionReading())
}

beforeEach(async () => {
  diagnostics.length = 0
  page = await browser.newPage({ viewport: { width: 800, height: 700 } })
  page.setDefaultTimeout(5_000)
  page.setDefaultNavigationTimeout(30_000)
  page.on("pageerror", (error) => diagnostics.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) diagnostics.push(`${response.status()} ${response.url()}`)
  })
  page.on("requestfailed", (request) => diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`))
  await load()
}, 45_000)

afterEach(async () => {
  try {
    expect(diagnostics).toEqual([])
  } finally {
    await page?.close()
  }
})

afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [
    () => browser?.close(),
    () => server?.close(),
    () => directory && rm(directory, { recursive: true, force: true }),
  ]) {
    try {
      await close()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, "ProcessViewport fixture cleanup failed")
})

test("repeated wheel pauses notify reading only when following changes, including after returning to latest", async () => {
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as FixtureWindow).processViewportFixture
    const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
    for (let input = 0; input < 6; input++)
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }))
    await harness.frames()
    const firstPause = [...harness.notifications]
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }))
    await harness.frames()
    const repeatedPause = [...harness.notifications]
    document.querySelector<HTMLButtonElement>('[data-slot="process-latest"]')!.click()
    await harness.frames()
    const latest = [...harness.notifications]
    for (let input = 0; input < 4; input++)
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }))
    await harness.frames()
    return {
      firstPause,
      repeatedPause,
      latest,
      nextPause: [...harness.notifications],
      interactions: harness.interactions,
    }
  })
  expect(result).toEqual({
    firstPause: [true],
    repeatedPause: [true],
    latest: [true, false],
    nextPause: [true, false, true],
    interactions: 11,
  })
})

test("wheel, scroll, keyboard and touch input in one frame share one reading-anchor capture", async () => {
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as FixtureWindow).processViewportFixture
    await harness.frames(1)
    harness.burst()
    await harness.frames()
    const first = [...harness.captures]
    harness.captures.length = 0
    harness.burst()
    await harness.frames()
    return { first, next: harness.captures, notifications: harness.notifications }
  })
  expect(result.first).toHaveLength(1)
  expect(result.first[0].target).toBeNull()
  expect(result.first[0].anchor?.partID).toBe("part-12")
  expect(result.next).toHaveLength(1)
  expect(result.next[0].target).toBeNull()
  expect(result.notifications).toEqual([true])
})

test("synchronous disclosure captures its target before layout and pending input cannot overwrite it", async () => {
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as FixtureWindow).processViewportFixture
    const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
    const trigger = document.getElementById("disclosure-trigger")!
    await harness.frames(1)
    harness.burst()
    harness.clear()
    const offset = trigger.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    trigger.click()
    const disclosure = harness.disclosure!
    await harness.frames()
    return {
      disclosure,
      beforeLayouts: harness.beforeLayouts,
      captures: harness.captures,
      restores: harness.restores,
      displacement: trigger.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset,
    }
  })
  expect(result.disclosure.afterHeight).toBeGreaterThan(result.disclosure.beforeHeight)
  expect(result.beforeLayouts).toEqual([{ target: "disclosure-trigger", height: result.disclosure.beforeHeight }])
  expect(result.disclosure.captures.map((capture) => capture.target)).toEqual(["disclosure-trigger"])
  expect(result.disclosure.captures[0].height).toBe(result.disclosure.beforeHeight)
  expect(result.captures.map((capture) => capture.target)).toEqual(["disclosure-trigger"])
  expect(result.restores.length).toBeGreaterThan(0)
  expect(result.disclosure.captures[0].anchor).toBeDefined()
  for (const anchor of result.restores) expect(anchor).toEqual(result.disclosure.captures[0].anchor!)
  expect(Math.abs(result.displacement)).toBeLessThanOrEqual(1)
})

for (const intent of ["focus", "selection"] as const) {
  test(`${intent} pauses local reading while characterData and childList growth retain the paragraph and content`, async () => {
    await load("local")
    const result = await page.evaluate(async (intent) => {
      const harness = (window as unknown as FixtureWindow).processViewportFixture
      const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
      const paragraph = document.getElementById("reading-paragraph")!
      const trigger = document.getElementById("disclosure-trigger")!
      const text = paragraph.firstChild!
      if (intent === "focus") trigger.focus({ preventScroll: true })
      else {
        const range = document.createRange()
        range.selectNodeContents(paragraph)
        document.getSelection()!.removeAllRanges()
        document.getSelection()!.addRange(range)
      }
      const selectionAnchor = document.getSelection()?.anchorNode
      await harness.frames()
      const offset = paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      const displacements: number[] = []
      const heights: number[] = [viewport.scrollHeight]
      for (const position of ["above", "below"] as const) {
        for (const grow of [harness.growCharacterData, harness.growChildList]) {
          grow(position)
          await harness.frames()
          heights.push(viewport.scrollHeight)
          displacements.push(paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset)
        }
      }
      return {
        notifications: harness.notifications,
        displacements,
        heights,
        sameParagraph: document.getElementById("reading-paragraph") === paragraph,
        sameText: paragraph.firstChild === text,
        focused: document.activeElement === trigger,
        selected: document.getSelection()?.toString(),
        selectedNode: document.getSelection()?.anchorNode === selectionAnchor,
        localCaptures: harness.captures.length,
      }
    }, intent)
    expect(result.notifications).toEqual([true])
    expect(result.heights.every((height, index) => index === 0 || height > result.heights[index - 1])).toBe(true)
    expect(result.displacements.every((offset) => Math.abs(offset) <= 1)).toBe(true)
    expect(result.sameParagraph).toBe(true)
    expect(result.sameText).toBe(true)
    expect(result.localCaptures).toBe(0)
    if (intent === "focus") expect(result.focused).toBe(true)
    else {
      expect(result.selected).toBe("Reading activity 12 remains in place.")
      expect(result.selectedNode).toBe(true)
    }
  })
}

test("a detached default local anchor survives live body growth without a revision or custom anchor callbacks", async () => {
  await load("local")
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as FixtureWindow).processViewportFixture
    const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
    const paragraph = document.getElementById("reading-paragraph")!
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }))
    await harness.frames()
    const offset = paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    const beforeHeight = viewport.scrollHeight
    harness.growCharacterData("above")
    harness.growChildList("below")
    await harness.frames()
    const first = paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset
    harness.growChildList("above")
    harness.growCharacterData("below")
    await harness.frames()
    return {
      beforeHeight,
      afterHeight: viewport.scrollHeight,
      displacements: [first, paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset],
      notifications: harness.notifications,
      captures: harness.captures,
      restores: harness.restores,
      sameParagraph: document.getElementById("reading-paragraph") === paragraph,
      latest: !!document.querySelector('[data-slot="process-latest"]'),
    }
  })
  expect(result.afterHeight).toBeGreaterThan(result.beforeHeight)
  expect(result.displacements.every((offset) => Math.abs(offset) <= 1)).toBe(true)
  expect(result.notifications).toEqual([true])
  expect(result.captures).toEqual([])
  expect(result.restores).toEqual([])
  expect(result.sameParagraph).toBe(true)
  expect(result.latest).toBe(true)
})

test("consumer root identity excludes direct child mount and unmount but preserves nested body mutations", async () => {
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as FixtureWindow).processViewportFixture
    const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
    const root = document.querySelector('[data-slot="process-virtualizer"]')!
    harness.pause()
    await harness.frames()
    harness.clear()
    const height = viewport.scrollHeight
    const row = document.createElement("div")
    row.dataset.slot = "process-virtualizer"
    row.style.cssText = "position:absolute;top:0;left:0;width:100px;height:24px;overflow:hidden"
    const paragraph = document.createElement("p")
    paragraph.textContent = "Mounted row body"
    row.append(paragraph)
    root.append(row)
    await harness.frames()
    const mount = harness.restores.length
    harness.clear()
    ;(paragraph.firstChild as Text).appendData(" streamed delta")
    await harness.frames()
    const characterData = harness.restores.length
    harness.clear()
    row.append(document.createElement("span"))
    await harness.frames()
    const childList = harness.restores.length
    harness.clear()
    row.remove()
    await harness.frames()
    return {
      mount,
      characterData,
      childList,
      unmount: harness.restores.length,
      height,
      finalHeight: viewport.scrollHeight,
    }
  })
  expect(result.finalHeight).toBe(result.height)
  expect(result.mount).toBe(0)
  expect(result.unmount).toBe(0)
  expect(result.characterData).toBeGreaterThan(0)
  expect(result.childList).toBeGreaterThan(0)
})

test("without a consumer classifier the shared viewport conservatively preserves virtual-root mutations", async () => {
  await load("instrumented", "default")
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as FixtureWindow).processViewportFixture
    const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
    const root = document.querySelector('[data-slot="process-virtualizer"]')!
    harness.pause()
    await harness.frames()
    harness.clear()
    const height = viewport.scrollHeight
    const row = document.createElement("div")
    row.style.cssText = "position:absolute;top:0;width:100px;height:24px;overflow:hidden"
    row.textContent = "Mounted virtual row"
    root.append(row)
    await harness.frames()
    const mount = harness.restores.length
    harness.clear()
    row.remove()
    await harness.frames()
    return { mount, unmount: harness.restores.length, height, finalHeight: viewport.scrollHeight }
  })
  expect(result.finalHeight).toBe(result.height)
  expect(result.mount).toBeGreaterThan(0)
  expect(result.unmount).toBeGreaterThan(0)
})

test("mixed virtual churn and nested body records in the same delivery still protect detached reading", async () => {
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as FixtureWindow).processViewportFixture
    const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
    const root = document.querySelector('[data-slot="process-virtualizer"]')!
    harness.pause()
    await harness.frames()
    harness.clear()
    const height = viewport.scrollHeight
    const row = document.createElement("div")
    row.style.cssText = "position:absolute;top:0;width:100px;height:24px;overflow:hidden"
    const paragraph = document.createElement("p")
    paragraph.textContent = "Streaming virtual row"
    row.append(paragraph)
    root.append(row)
    ;(paragraph.firstChild as Text).appendData(" body delta")
    await harness.frames()
    const mountAndCharacterData = harness.restores.length
    harness.clear()
    row.remove()
    root.querySelector('[data-slot="activity-step"]')!.append(document.createElement("span"))
    await harness.frames()
    return {
      mountAndCharacterData,
      unmountAndChildList: harness.restores.length,
      height,
      finalHeight: viewport.scrollHeight,
    }
  })
  expect(result.finalHeight).toBe(result.height)
  expect(result.mountAndCharacterData).toBeGreaterThan(0)
  expect(result.unmountAndChildList).toBeGreaterThan(0)
})

test("scrolling across paragraphs settles on the visible anchor before later growth between old and new anchors", async () => {
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as FixtureWindow).processViewportFixture
    const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
    const paragraph = document.querySelector<HTMLElement>('[data-part-id="part-18"] p')!
    const between = document.querySelector<HTMLElement>('[data-part-id="part-15"] p')!
    await harness.frames(1)
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }))
    const first = harness.captures[0]?.anchor?.partID
    viewport.scrollTop += paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 8
    viewport.dispatchEvent(new Event("scroll"))
    await harness.frames()
    const settled = harness.captures.at(-1)?.anchor?.partID
    const offset = paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    ;(between.firstChild as Text).appendData(" Intermediate body growth after input has stopped.".repeat(24))
    await harness.frames()
    return {
      first,
      settled,
      displacement: paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset,
    }
  })
  expect(result.first).toBe("part-12")
  expect(result.settled).toBe("part-18")
  expect(Math.abs(result.displacement)).toBeLessThanOrEqual(1)
})

test("same-frame cross-paragraph scrolling protects the new visible anchor from immediate intermediate growth", async () => {
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as FixtureWindow).processViewportFixture
    const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
    const paragraph = document.querySelector<HTMLElement>('[data-part-id="part-18"] p')!
    const between = document.querySelector<HTMLElement>('[data-part-id="part-15"] p')!
    await harness.frames(1)
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }))
    const first = harness.captures[0]?.anchor?.partID
    viewport.scrollTop += paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 8
    viewport.dispatchEvent(new Event("scroll"))
    const offset = paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    ;(between.firstChild as Text).appendData(" Immediate intermediate body growth.".repeat(24))
    await harness.frames()
    return {
      first,
      restored: harness.restores[0]?.partID,
      displacement: paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset,
    }
  })
  expect(result.first).toBe("part-12")
  expect(result.restored).toBe("part-18")
  expect(Math.abs(result.displacement)).toBeLessThanOrEqual(1)
})

for (const mutation of ["characterData", "childList"] as const) {
  test(`input captures before immediate ${mutation} growth and real same-frame movement refreshes the reading anchor`, async () => {
    const result = await page.evaluate(async (mutation) => {
      const harness = (window as unknown as FixtureWindow).processViewportFixture
      const viewport = document.querySelector<HTMLElement>('[data-component="process-viewport"]')!
      const paragraph = document.getElementById("reading-paragraph")!
      await harness.frames(1)
      const beforeHeight = viewport.scrollHeight
      const originalOffset = paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      const startTop = viewport.scrollTop
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }))
      const synchronousCaptures = harness.captures.length
      const capturedAnchor = harness.captures[0]?.anchor
      for (const delta of [-12, -9]) {
        viewport.scrollTop += delta
        viewport.dispatchEvent(new Event("scroll"))
      }
      const inputDisplacement = viewport.scrollTop - startTop
      const inputOffset = paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      const capturesBeforeGrowth = harness.captures.length
      if (mutation === "characterData") harness.growCharacterData("above")
      else harness.growChildList("above")
      await harness.frames()
      return {
        beforeHeight,
        afterHeight: viewport.scrollHeight,
        originalOffset,
        inputOffset,
        inputDisplacement,
        synchronousCaptures,
        capturesBeforeGrowth,
        captures: harness.captures,
        capturedAnchor,
        restores: harness.restores,
        displacement: paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - inputOffset,
        notifications: harness.notifications,
        sameParagraph: document.getElementById("reading-paragraph") === paragraph,
      }
    }, mutation)
    expect(result.synchronousCaptures).toBe(1)
    expect(result.capturesBeforeGrowth).toBe(3)
    expect(result.captures).toHaveLength(3)
    expect(result.captures.every((capture) => capture.height === result.beforeHeight && capture.restores === 0)).toBe(
      true,
    )
    expect(result.capturedAnchor?.partID).toBe("part-12")
    expect(result.inputDisplacement).toBe(-21)
    expect(Math.abs(result.inputOffset - result.originalOffset + result.inputDisplacement)).toBeLessThanOrEqual(1)
    expect(result.afterHeight).toBeGreaterThan(result.beforeHeight)
    expect(result.restores.length).toBeGreaterThan(0)
    const movedAnchor = result.captures.at(-1)!.anchor!
    for (const anchor of result.restores) expect(anchor).toEqual(movedAnchor)
    expect(Math.abs(result.displacement)).toBeLessThanOrEqual(1)
    expect(result.notifications).toEqual([true])
    expect(result.sameParagraph).toBe(true)
  })
}

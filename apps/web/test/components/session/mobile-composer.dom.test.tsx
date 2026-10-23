import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

// The narrow Composer contract is structural and geometric at the same time:
// the card must hold at most four controls, the chip line must carry the state
// controls, the resize separator must stay draggable on touch, and none of that
// may change the desktop layout. This suite therefore mounts the real
// `DefaultComposer` around the real `createPromptInputController` and loads the
// real stylesheet, so the assertions describe shipped code rather than a copy
// of its markup.
const root = path.resolve(import.meta.dir, "../../fixtures/mobile-composer")
const source = path.resolve(import.meta.dir, "../../../src")
const stubs = path.join(root, "stubs.tsx")

// `resolve.alias` runs before `resolveId`, so the plugin sees `/…/src/…` for
// every `@/…` import. Matching both forms is what keeps the real context
// providers out of the fixture.
const stubbed = [
  /(?:^@\/|\/src\/)context\/(?:sdk|global-sdk|global-sync|sync|local|input|prompt|command|server|platform|workbench|session-transition|session-data-view|session-route|plan-blueprint-offer|view-residency|file)(?:\/index)?(?:\.tsx?)?$/,
  /(?:^@\/|\/src\/)context\/layout(?:\/index)?(?:\.tsx?)?$/,
  /(?:^@\/|\/src\/)context\/locale(?:\/index)?(?:\.tsx?)?$/,
  /(?:^@\/|\/src\/)components\/settings(?:\/index)?(?:\.tsx?)?$/,
  /(?:^@\/|\/src\/)components\/lattice\/lattice-config-dialog(?:\.tsx?)?$/,
  /^@solidjs\/router$/,
]

let browser: Browser
let server: ViteDevServer
let baseUrl: string
let cache: string
const errors: string[] = []

beforeAll(async () => {
  // Vite writes optimized dependencies next to its cacheDir; keeping that in the
  // system temp directory leaves the checked-in fixture tree clean even when a
  // run is interrupted before cleanup.
  cache = await mkdtemp(path.join(tmpdir(), "mobile-composer-tree-"))
  server = await createServer({
    configFile: false,
    root,
    cacheDir: cache,
    plugins: [
      {
        name: "mobile-composer-stubs",
        enforce: "pre",
        resolveId(id) {
          if (stubbed.some((pattern) => pattern.test(id))) return stubs
        },
      },
      solid(),
      tailwind(),
      ...lingui(),
    ],
    resolve: { alias: { "@": source } },
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/store", "@lingui/core", "@lingui/solid", "zod", "fuzzysort"],
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      strictPort: true,
      fs: { allow: [path.resolve(source, "../../.."), root] },
    },
  })
  await server.listen()
  baseUrl = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (cache) await rm(cache, { recursive: true, force: true })
})

async function open(viewport: { width: number; height: number }, touch: boolean) {
  errors.length = 0
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch })
  const page = await context.newPage()
  page.setDefaultTimeout(8_000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(baseUrl, { timeout: 90_000 })
  await page.locator(".prompt-input-shell").waitFor()
  await page.locator(".prompt-input-toolbar").waitFor()
  return { page, close: () => context.close() }
}

const style = (page: Page, selector: string, property: string) =>
  page.locator(selector).evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)

// A touch context makes the page *capable* of touch, but `page.mouse` still
// dispatches mouse events, so it cannot prove that a finger can drag: the
// browser only applies its own gesture arbitration to real touch input. These
// helpers therefore drive Chromium through CDP, which is what surfaced the
// cancellation that a fixed `touch-action` has to prevent.
const touchStart = async (page: Page, from: { x: number; y: number }) => {
  const session = await page.context().newCDPSession(page)
  const points = (point: { x: number; y: number }) => [
    { x: point.x, y: point.y, id: 1, radiusX: 4, radiusY: 4, force: 1 },
  ]
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) })
  return {
    move: (point: { x: number; y: number }) =>
      session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(point) }),
    end: async () => {
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      await session.detach()
    },
  }
}

// Stops short of the viewport edge so every move stays a real coordinate.
const upwardPath = (from: { x: number; y: number }, distance: number, steps = 10) =>
  Array.from({ length: steps }, (_, index) => ({
    x: from.x,
    y: Math.max(2, from.y - (distance * (index + 1)) / steps),
  }))

// Only controls a user can reach count towards the card budget. The model
// trigger is rendered inside `.prompt-input-mobile-model`, which the shipped
// sheet hides under the default shell, so it must not be counted — and must not
// be used to smuggle in a fifth reachable control either.
const shellButtons = (page: Page) =>
  page.locator(".prompt-input-shell button").evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({
        label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
      })),
  )

const rowBands = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((elements) =>
      [
        ...new Set(
          elements
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => Math.round(element.getBoundingClientRect().y)),
        ),
      ].sort((a, b) => a - b),
    )

test("the shipped narrow card holds four controls on one row above a single chip line", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    const buttons = await shellButtons(page)
    expect(buttons.map((button) => button.label).sort()).toEqual([
      "Add",
      "Expand editor",
      "Send message",
      "Voice input",
    ])

    const card = (await page.locator(".prompt-input-shell").boundingBox())!
    expect(card.height).toBeLessThanOrEqual(160)
    expect(await rowBands(page, ".prompt-input-toolbar button")).toHaveLength(1)
    expect(await style(page, ".composer-chips-row", "display")).toBe("flex")
    expect(await style(page, ".composer-chips-row", "overflow-x")).toBe("auto")
    expect(await style(page, ".prompt-input-toolbar", "flex-wrap")).toBe("nowrap")

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    )
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("the chip line keeps the project, agent and permission controls at the touch floor", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    const chips = page.locator(".composer-chips-row")
    await chips.locator("[data-computer-selector]").waitFor()
    await chips.locator("[data-project-task-selector]").waitFor()
    const labels = await chips
      .locator("button")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? ""))
    expect(labels.some((label) => label.startsWith("Computer"))).toBe(true)
    expect(labels.some((label) => label.includes("permission mode"))).toBe(true)
    expect(labels.some((label) => label.startsWith("Select agent"))).toBe(true)

    const measures = await chips
      .locator("button")
      .evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)))
    expect(measures.length).toBeGreaterThan(0)
    for (const height of measures) expect(height).toBeGreaterThanOrEqual(44)

    const row = (await chips.boundingBox())!
    expect(row.height).toBeLessThanOrEqual(44)
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("mobile configuration uses one quiet text scale and keeps menu state distinct from selection", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    const project = "[data-project-task-selector]"
    const agent = '.mobile-composer-chips button[aria-label^="Select agent"]'
    const permission = '.mobile-composer-chips button[aria-label*="permission mode"]'
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme })
      await page.waitForFunction((scheme) => document.documentElement.dataset.colorScheme === scheme, colorScheme)
      const typography = await Promise.all(
        [project, agent, permission].map((selector) =>
          page.locator(`${selector} > span`).evaluate((element) => {
            const style = getComputedStyle(element)
            return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight]
          }),
        ),
      )
      expect(typography[0]).toEqual(typography[1])
      expect(typography[1]).toEqual(typography[2])
      for (const selector of [project, agent, permission]) {
        expect(await style(page, selector, "background-color")).toBe("rgba(0, 0, 0, 0)")
      }

      await page.locator(agent).click()
      const menu = page.getByRole("dialog", { name: "Select agent", exact: true })
      await menu.waitFor()
      expect(await page.locator(agent).getAttribute("aria-expanded")).toBe("true")
      await page.waitForFunction(
        (selector) => getComputedStyle(document.querySelector(selector)!).backgroundColor !== "rgba(0, 0, 0, 0)",
        agent,
      )
      expect(await style(page, agent, "background-color")).not.toBe("rgba(0, 0, 0, 0)")
      await page.keyboard.press("Escape")
      await menu.waitFor({ state: "detached" })
      expect(await page.locator(agent).getAttribute("aria-expanded")).toBe("false")
      await page.waitForFunction((selector) => document.querySelector(selector) === document.activeElement, agent)
      expect(await page.locator(agent).evaluate((element) => element === document.activeElement)).toBe(true)
      await page.locator('[data-component="prompt-input"]').click()
      await page.waitForFunction(
        (selector) => getComputedStyle(document.querySelector(selector)!).backgroundColor === "rgba(0, 0, 0, 0)",
        agent,
      )
    }
    await page.emulateMedia({ reducedMotion: "reduce" })
    for (const selector of [project, agent, permission, ".composer-expand-control"])
      expect(await style(page, selector, "transition-duration")).toBe("0s")
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("the corner control drags to resize, taps to expand, and never covers a typed character", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    // The narrow layout folds resizing onto the corner control, so the top-seam
    // separator must not be reachable here — a second 44-pixel target either
    // covers the first line or spends the card's fifth target. It stays in the
    // DOM for the desktop layout and is hidden by the narrow rule.
    expect(await page.locator(".composer-resize-handle").evaluate((element) => element.getClientRects().length)).toBe(0)
    const control = page.locator(".composer-expand-control")
    const box = (await control.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(await page.locator(".session-composer").getAttribute("data-resized")).toBeNull()
    const before = (await page.locator(".session-composer-editor").boundingBox())!.height

    // Chromium only arbitrates gestures for real touch input. Without a
    // touch-action policy on this target the browser claims the vertical drag
    // for panning and cancels the gesture after two moves, so the drag below is
    // driven through CDP and the policy is asserted alongside it.
    expect(await style(page, ".composer-expand-control", "touch-action")).toBe("none")
    // The failure mode is visible in the event sequence itself, not only in its
    // effect: a target without a touch policy emits pointerdown, a couple of
    // moves and then pointercancel with no pointerup at all. Recording the
    // sequence keeps that distinction under test instead of inferring it from a
    // height that a mouse-driven test could also produce.
    await page.evaluate(() => {
      const record: string[] = []
      ;(window as unknown as { pointerSequence: string[] }).pointerSequence = record
      const target = document.querySelector(".composer-expand-control")!
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"])
        target.addEventListener(type, () => record.push(type), { capture: true })
    })
    const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const drag = await touchStart(page, origin)
    for (const point of upwardPath(origin, 70)) await drag.move(point)
    await drag.end()

    const sequence = await page.evaluate(() => (window as unknown as { pointerSequence: string[] }).pointerSequence)
    expect(sequence[0]).toBe("pointerdown")
    expect(sequence.filter((type) => type === "pointermove").length).toBeGreaterThanOrEqual(2)
    expect(sequence.filter((type) => type === "pointerup")).toHaveLength(1)
    expect(sequence).not.toContain("pointercancel")
    expect(await page.locator(".session-composer").getAttribute("data-resized")).not.toBeNull()
    const after = (await page.locator(".session-composer-editor").boundingBox())!.height
    expect(after).toBeGreaterThan(before)
    // A drag must not also expand; only a tap does that.
    expect(await page.locator(".session-composer").getAttribute("data-expanded")).toBeNull()
    await control.click()
    expect(await page.locator(".session-composer").getAttribute("data-expanded")).not.toBeNull()

    // Typing across the width of the first line must stay hit-testable: every
    // glyph's centre resolves to the editor, not to a control.
    const hit = await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>('[data-component="prompt-input"]')!
      node.focus()
      const text = document.createTextNode("1234567890123456789012345678901234567890")
      node.replaceChildren(text)
      const range = document.createRange()
      const centres: Array<{ x: number; y: number }> = []
      for (let index = 0; index < text.length; index++) {
        range.setStart(text, index)
        range.setEnd(text, index + 1)
        for (const rect of range.getClientRects())
          centres.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
      }
      const hits = centres.map((point) => {
        const element = document.elementFromPoint(point.x, point.y)
        return element?.closest('[data-component="prompt-input"]')
          ? "editor"
          : (element?.className?.toString() ?? "none")
      })
      return { total: hits.length, stolen: hits.filter((value) => value !== "editor") }
    })
    expect(hit.total).toBeGreaterThan(30)
    expect(hit.stolen).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("the merged control restores a cancelled drag and arms expansion past the limit", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    const control = page.locator(".composer-expand-control")
    const box = (await control.boundingBox())!
    const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const height = async () => Math.round((await page.locator(".session-composer-editor").boundingBox())!.height)
    const resting = await height()

    // Folding the gesture onto this control must keep the separator's escape
    // hatch: a mis-drag otherwise has no way back except another drag that lands
    // on an arbitrary height.
    const cancelled = await touchStart(page, origin)
    for (const point of upwardPath(origin, 60, 6)) await cancelled.move(point)
    expect(await height()).toBeGreaterThan(resting)
    await page.keyboard.press("Escape")
    await cancelled.end()
    expect(await height()).toBe(resting)
    expect(await page.locator(".session-composer").getAttribute("data-resized")).toBeNull()
    expect(await page.locator(".session-composer").getAttribute("data-expanded")).toBeNull()

    // Past the manual limit the editor stays bounded while an instruction
    // reports continued progress; 32 further pixels arm expansion on release.
    const cue = page.locator(".composer-expand-cue")
    const armed = () => cue.getAttribute("data-armed")
    const second = await touchStart(page, origin)
    let travelled = 0
    while (travelled < 500 && (await cue.count()) === 0) {
      travelled += 16
      await second.move({ x: origin.x, y: origin.y - travelled })
    }
    expect(await cue.count()).toBe(1)
    expect(await armed()).toBeNull()
    expect(await cue.innerText()).toContain("Continue dragging to expand")
    // The editor is bounded at the manual limit while the drag keeps going.
    const bounded = await height()
    await second.move({ x: origin.x, y: origin.y - travelled - 16 })
    expect(await height()).toBe(bounded)

    while (travelled < 500 && (await armed()) === null) {
      travelled += 16
      await second.move({ x: origin.x, y: origin.y - travelled })
    }
    expect(await armed()).not.toBeNull()
    expect(await cue.innerText()).toContain("Release to expand")
    await second.end()
    expect(await page.locator(".session-composer").getAttribute("data-expanded")).not.toBeNull()
    expect(await page.locator(".composer-expand-cue").count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("the merged control keeps the separator's cancel and armed release for pointer input", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, false)
  try {
    const control = page.locator(".composer-expand-control")
    const box = (await control.boundingBox())!
    const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const height = async () => Math.round((await page.locator(".session-composer-editor").boundingBox())!.height)
    const resting = await height()

    // A narrowed desktop window reaches this layout with a mouse, so the
    // separator's escape hatch has to work there too: cancel restores the
    // previous height rather than leaving the mis-drag in place.
    await page.mouse.move(origin.x, origin.y)
    await page.mouse.down()
    await page.mouse.move(origin.x, origin.y - 60, { steps: 6 })
    expect(await height()).toBeGreaterThan(resting)
    await page.keyboard.press("Escape")
    await page.mouse.up()
    expect(await height()).toBe(resting)
    expect(await page.locator(".session-composer").getAttribute("data-resized")).toBeNull()
    expect(await page.locator(".session-composer").getAttribute("data-expanded")).toBeNull()

    const cue = page.locator(".composer-expand-cue")
    const armed = async () => ((await cue.count()) === 0 ? null : cue.getAttribute("data-armed"))
    await page.mouse.move(origin.x, origin.y)
    await page.mouse.down()
    let travelled = 0
    while (travelled < 500 && (await armed()) === null) {
      travelled += 16
      await page.mouse.move(origin.x, origin.y - travelled)
    }
    expect(await armed()).not.toBeNull()
    expect(await cue.innerText()).toContain("Release to expand")
    await page.mouse.up()
    expect(await page.locator(".session-composer").getAttribute("data-expanded")).not.toBeNull()
    expect(await page.locator(".composer-expand-cue").count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("every extracted control still opens from the shipped surfaces", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    const menu = async (trigger: string, title: string, item: string) => {
      await page.locator(trigger).click()
      const dialog = page.getByRole("dialog", { name: title, exact: true })
      await dialog.waitFor()
      const found = dialog.getByText(item, { exact: false }).first()
      await found.waitFor()
      await page.keyboard.press("Escape")
      await dialog.waitFor({ state: "detached" })
    }

    await menu(".prompt-input-add-button", "Add", "Predict next input")
    await menu("[data-computer-selector]", "Computer", "127.0.0.1:1")
    await menu("[data-project-task-selector]", "Choose project", "Fixture project")
    await menu('.mobile-composer-chips button[aria-label^="Select agent"]', "Select agent", "Pico")
    await menu('.mobile-composer-chips button[aria-label*="permission mode"]', "Permission mode", "Guarded")
    await page.locator(".prompt-input-add-button").click()
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("dialog", { name: "Add", exact: true }).getByText("Add files", { exact: true }).click(),
    ])
    expect(chooser.isMultiple()).toBe(true)
    await chooser.setFiles([])
    await page.locator(".composer-expand-control").click()
    expect(await page.locator(".session-composer").getAttribute("data-expanded")).not.toBeNull()
    await page.locator(".composer-expand-control").click()
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("the composer.above plugin slot keeps rendering above the chip line", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    const slot = page.locator('[data-slot="composer.above"]')
    await slot.waitFor()
    expect(await slot.innerText()).toContain("Plugin contribution")
    expect(await page.locator(".composer-chips-row").count()).toBe(1)
    expect(
      await page.evaluate(
        () =>
          document
            .querySelector('[data-slot="composer.above"]')
            ?.compareDocumentPosition(document.querySelector(".composer-chips-row")!) ===
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("320 pixels scrolls the chip line instead of overflowing the page", async () => {
  const { page, close } = await open({ width: 320, height: 640 }, true)
  try {
    const chips = page.locator(".composer-chips-row")
    await chips.locator("[data-computer-selector]").waitFor()
    expect(await style(page, ".composer-chips-row", "flex-wrap")).toBe("nowrap")
    expect(await chips.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    )
    // The review reproduced the sub-floor controls at 320 as well as 375, so the
    // touch floor is asserted at the narrowest supported width too.
    const heights = await chips
      .locator("button")
      .evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)))
    expect(heights.length).toBeGreaterThan(0)
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44)
    for (const button of await shellButtons(page)) expect(button.height).toBeGreaterThanOrEqual(44)
    const card = (await page.locator(".prompt-input-shell").boundingBox())!
    expect(card.height).toBeLessThanOrEqual(160)
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("responsive entry points retain one Composer and prediction owner across breakpoints", async () => {
  const { page, close } = await open({ width: 1280, height: 812 }, false)
  try {
    await page.getByRole("button", { name: "Predict next input", exact: true }).waitFor()
    const editor = page.getByRole("textbox", { name: "Send message", exact: true })
    await editor.fill("Keep this draft while resizing")
    const originalEditor = await editor.elementHandle()
    for (const width of [375, 1280, 320, 1280]) {
      await page.setViewportSize({ width, height: 812 })
      const prediction = page.getByRole("button", { name: "Predict next input", exact: true })
      await prediction.waitFor({ state: width >= 768 ? "visible" : "hidden" })
      expect(errors).toEqual([])
      expect(await editor.evaluate((element, original) => element === original, originalEditor)).toBe(true)
      expect(await editor.textContent()).toBe("Keep this draft while resizing")
      if (width >= 768) {
        expect(await prediction.count()).toBe(1)
        continue
      }
      await page.getByRole("button", { name: "Add", exact: true }).click()
      const menu = page.getByRole("dialog", { name: "Add", exact: true })
      await menu.getByText("Predict next input", { exact: true }).waitFor()
      expect(await menu.getByText("Predict next input", { exact: true }).count()).toBe(1)
      await page.keyboard.press("Escape")
      await menu.waitFor({ state: "detached" })
    }
  } finally {
    await close()
    expect(errors).toEqual([])
  }
}, 120_000)

test("desktop keeps the original context line, one wrapping toolbar and its own control set", async () => {
  const { page, close } = await open({ width: 1440, height: 900 }, false)
  try {
    expect(await style(page, ".composer-chips-row", "display")).toBe("contents")
    expect(await style(page, ".prompt-input-toolbar", "flex-wrap")).toBe("wrap")
    expect(await page.locator(".mobile-composer-chips").count()).toBe(0)

    const buttons = await shellButtons(page)
    expect(buttons.map((button) => button.label)).toContain("Predict next input")
    for (const button of buttons) expect(button.height).toBeLessThan(44)

    const handle = (await page.locator(".composer-resize-handle").boundingBox())!
    expect(handle.width).toBeGreaterThan(44)
    expect(handle.height).toBeLessThan(44)

    // The desktop reading is pinned by number, not by "the wrapper is present":
    // these are the shipped measurements of the card, editor, toolbar and
    // corner control at this size.
    const geometry = () =>
      page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100
        const box = (selector: string) => {
          const element = document.querySelector(selector)
          if (!element) return null
          const rect = element.getBoundingClientRect()
          return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) }
        }
        const shell = document.querySelector(".prompt-input-shell") as HTMLElement
        return {
          shell: box(".prompt-input-shell"),
          editor: box(".session-composer-editor"),
          toolbar: box(".prompt-input-toolbar"),
          expandControl: box(".composer-expand-control"),
          toolbarPadding: getComputedStyle(document.querySelector(".prompt-input-toolbar")!).padding,
          shellPaddingTop: getComputedStyle(shell).paddingTop,
          controls: [...shell.querySelectorAll("button, [role=separator]")].filter(
            (element) => element.getClientRects().length > 0,
          ).length,
        }
      })

    const desktop = await geometry()
    expect(desktop.shell).toEqual({ x: 344, y: 778, w: 752, h: 122 })
    expect(desktop.editor?.h).toBe(64)
    expect(desktop.toolbar?.h).toBe(48)
    expect(desktop.expandControl).toEqual({ x: 1055, y: 783, w: 32, h: 32 })
    expect(desktop.toolbarPadding).toBe("6px 12px 8px")
    expect(desktop.shellPaddingTop).toBe("8px")
    expect(desktop.controls).toBe(8)

    // The chip wrapper is `display: contents`, so removing it must not move a
    // single pixel. This is the "desktop is unchanged by construction" claim,
    // measured in one page instead of compared against a remembered baseline.
    const withoutWrapper = await page.evaluate(() => {
      const shell = document.querySelector(".prompt-input-shell")!
      const wrapper = shell.parentElement?.querySelector(".composer-chips-row")
      wrapper?.remove()
      const round = (value: number) => Math.round(value * 100) / 100
      const rect = shell.getBoundingClientRect()
      const editor = document.querySelector(".session-composer-editor")!.getBoundingClientRect()
      const toolbar = document.querySelector(".prompt-input-toolbar")!.getBoundingClientRect()
      return {
        shell: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) },
        editorHeight: round(editor.height),
        toolbarHeight: round(toolbar.height),
        wrapperPresent: !!document.querySelector(".composer-chips-row"),
      }
    })
    expect(withoutWrapper.wrapperPresent).toBe(false)
    expect(withoutWrapper.shell).toEqual(desktop.shell!)
    expect(withoutWrapper.editorHeight).toBe(desktop.editor!.h)
    expect(withoutWrapper.toolbarHeight).toBe(desktop.toolbar!.h)
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

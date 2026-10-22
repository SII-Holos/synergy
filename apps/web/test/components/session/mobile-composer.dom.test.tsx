import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { rm } from "node:fs/promises"
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
const errors: string[] = []

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root,
    cacheDir: path.join(root, ".vite"),
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
  await rm(path.join(root, ".vite"), { recursive: true, force: true })
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
    expect(row.height).toBeLessThanOrEqual(52)
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

test("dragging the separator on touch still resizes the editor", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    const handle = page.locator(".composer-resize-handle")
    const box = (await handle.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(await handle.getAttribute("role")).toBe("separator")
    expect(await page.locator(".prompt-input-shell").getAttribute("data-resized")).toBeNull()
    const before = (await page.locator(".session-composer-editor").boundingBox())!.height

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, { steps: 12 })
    await page.mouse.up()

    expect(await page.locator(".session-composer").getAttribute("data-resized")).not.toBeNull()
    const after = (await page.locator(".session-composer-editor").boundingBox())!.height
    expect(after).toBeGreaterThan(before)
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
    const card = (await page.locator(".prompt-input-shell").boundingBox())!
    expect(card.height).toBeLessThanOrEqual(160)
    expect(errors).toEqual([])
  } finally {
    await close()
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
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 120_000)

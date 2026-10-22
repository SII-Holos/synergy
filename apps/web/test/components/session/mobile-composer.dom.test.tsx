import { fixturePort } from "@ericsanchezok/synergy-testing/fixture"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"
import { lingui } from "@lingui/vite-plugin"

// Narrow layouts must keep the Composer on one toolbar row by moving agent,
// permission and workflow state onto a single scrolling chip line, and desktop
// layouts must keep the original context line untouched. Both outcomes are
// properties of the shipped stylesheet against the shipped class names, so this
// suite loads the real `index.css` and measures the real selectors at each
// breakpoint instead of asserting a copy of the numbers.
let browser: Browser
let server: ViteDevServer
let directory: string
let baseUrl: string
const errors: string[] = []
const source = path.resolve(import.meta.dir, "../../../src")

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".mobile-composer-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `
    import { render } from "solid-js/web"
    import "@ericsanchezok/synergy-ui/styles"
    import ${JSON.stringify(`/@fs/${source}/index.css`)}

    // Markup mirrors the shipped Composer tree: default-composer.tsx renders
    // the leading slot as a sibling of the shell form, and prompt-controller.tsx
    // puts the chip line in that slot and the toolbar inside the form. The
    // inline sheet restates only the Tailwind utilities those elements carry in
    // production (display, wrapping, gaps) because the fixture is not scanned by
    // the Tailwind content pipeline; every assertion below is about a
    // declaration that index.css owns.
    function Fixture() {
      return <div class="synergy-workbench-canvas" style="min-height:100dvh;display:flex;flex-direction:column;justify-content:flex-end">
        <div class="session-composer" style="width:100%">
          <div class="composer-chips-row">
            <div class="session-work-context">
              <button class="prompt-input-toolbar-button" type="button" aria-label="Choose project">Project</button>
            </div>
            <div class="mobile-composer-chips" role="group" aria-label="Composer options">
              <button class="prompt-input-toolbar-button" type="button" aria-label="Select agent: Pico">Agent</button>
              <button class="prompt-input-toolbar-button" type="button" aria-label="Guarded permission mode">Guarded</button>
            </div>
          </div>
          <form class="prompt-input-shell bg-input-base relative overflow-visible border border-border-base" style="width:343px;margin:0 auto">
            <div class="composer-resize-controls">
              <div role="separator" tabindex="0" aria-label="Resize editor" class="composer-resize-handle">
                <span aria-hidden="true" />
              </div>
            </div>
            <div class="session-composer-context"></div>
            <div class="session-composer-editor" style="height:64px"></div>
            <div class="prompt-input-toolbar">
              <div class="prompt-input-toolbar-main">
                <button class="prompt-input-toolbar-button" type="button" aria-label="Add">Add</button>
              </div>
              <div class="prompt-input-toolbar-actions">
                <button class="prompt-input-toolbar-icon-button" type="button" aria-label="Voice input">Voice</button>
                <button class="prompt-input-submit" type="button" aria-label="Send message">Send</button>
              </div>
            </div>
          </form>
        </div>
        <style>{\`
          .prompt-input-toolbar,.prompt-input-toolbar-main,.prompt-input-toolbar-actions{display:flex;align-items:center}
          .prompt-input-toolbar,.prompt-input-toolbar-main{flex-wrap:wrap}
          .prompt-input-toolbar{justify-content:space-between;gap:8px}
          .prompt-input-toolbar-main{gap:4px;min-width:0}
          .prompt-input-toolbar-actions{margin-left:auto;gap:6px;min-width:0;flex-shrink:0;justify-content:flex-end}
        \`}</style>
      </div>
    }

    render(() => <Fixture />, document.getElementById("root")!)
  `,
  )
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solid(), tailwind(), ...lingui()],
    optimizeDeps: {
      noDiscovery: true,
      include: ["solid-js", "solid-js/web", "solid-js/jsx-runtime", "@lingui/core", "@lingui/solid"],
    },
    server: {
      host: "127.0.0.1",
      port: await fixturePort(),
      fs: { allow: [path.resolve(source, "../../..")] },
    },
  })
  await server.listen()
  await server.warmupRequest("/main.tsx")
  baseUrl = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function open(viewport: { width: number; height: number }, touch: boolean) {
  errors.length = 0
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch })
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(baseUrl)
  await page.locator(".prompt-input-toolbar").waitFor()
  return { page, close: () => context.close() }
}

const style = (page: Page, selector: string, property: string) =>
  page.locator(selector).evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)

const rowBands = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((elements) =>
      [...new Set(elements.map((element) => Math.round(element.getBoundingClientRect().y)))].sort((a, b) => a - b),
    )

// Centered rows mix 44px and 36px controls, so equal `y` is the wrong test for
// "one row". The promise is one row, which means the vertical centers of that
// row's controls stay inside a single 8px band.
const centeringSpread = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((elements) => {
    const centers = elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return rect.y + rect.height / 2
    })
    return Math.max(...centers) - Math.min(...centers)
  })

test("a narrow composer keeps one toolbar row and one scrolling chip line", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    expect(await style(page, ".composer-chips-row", "display")).toBe("flex")
    expect(await style(page, ".composer-chips-row", "overflow-x")).toBe("auto")
    expect(await style(page, ".composer-chips-row", "flex-wrap")).toBe("nowrap")
    expect(await style(page, ".prompt-input-toolbar", "flex-wrap")).toBe("nowrap")
    expect(await style(page, ".prompt-input-toolbar-main", "flex-wrap")).toBe("nowrap")

    // The card's toolbar controls share one band, and the chip line is a single
    // row of its own above the editor.
    expect(await rowBands(page, ".prompt-input-toolbar button")).toHaveLength(1)
    expect(await centeringSpread(page, ".composer-chips-row button")).toBeLessThanOrEqual(8)

    const toolbar = (await page.locator(".prompt-input-toolbar").boundingBox())!
    expect(toolbar.height).toBeLessThan(56)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    )
    expect(errors).toEqual([])
  } finally {
    await close()
  }
})

test("coarse pointers keep a 44px drag grip and 44px toolbar targets", async () => {
  const { page, close } = await open({ width: 375, height: 812 }, true)
  try {
    expect(await style(page, ".composer-resize-controls", "display")).not.toBe("none")
    const grip = (await page.locator(".composer-resize-handle").boundingBox())!
    expect(grip.width).toBeGreaterThanOrEqual(44)
    expect(grip.height).toBeGreaterThanOrEqual(44)
    const heights = await page
      .locator(".prompt-input-toolbar button")
      .evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)))
    expect(heights.length).toBeGreaterThan(0)
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44)
    expect(errors).toEqual([])
  } finally {
    await close()
  }
})

test("the chip wrapper participates as if absent at desktop width", async () => {
  const { page, close } = await open({ width: 1440, height: 900 }, false)
  try {
    expect(await style(page, ".composer-chips-row", "display")).toBe("contents")
    expect(await style(page, ".prompt-input-toolbar", "flex-wrap")).toBe("wrap")
    expect(await style(page, ".composer-resize-controls", "display")).not.toBe("none")
    const heights = await page
      .locator(".prompt-input-toolbar button")
      .evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height)))
    for (const height of heights) expect(height).toBeLessThan(44)
    expect(errors).toEqual([])
  } finally {
    await close()
  }
})

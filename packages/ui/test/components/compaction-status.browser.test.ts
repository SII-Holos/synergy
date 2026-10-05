import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { domFixture } from "../support/dom-fixtures"

type Fixture = {
  state(state: "running" | "committed" | "failed", terminal?: boolean): void
  replace(): void
  opened(): { kind: string; sessionID: string; messageID: string }[]
  theme(mode: "light" | "dark"): void
}
let server: ReturnType<typeof Bun.serve>
let browser: Browser
let page: Page
beforeAll(async () => {
  const directory = path.dirname(fileURLToPath(await domFixture("compaction-status.dom")))
  const styles = [...new Bun.Glob("*.css").scanSync({ cwd: directory })]
    .map((file) => `<link rel="stylesheet" href="/${file}">`)
    .join("")
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/")
        return new Response(
          `<!doctype html><head><meta name="viewport" content="width=device-width">${styles}<style>body{margin:16px;background:var(--background-base);color:var(--text-base)}</style></head><body><div id="root"></div><script>globalThis.process={env:{NODE_ENV:"test"}}</script><script type="module" src="/compaction-status.dom.js"></script></body>`,
          { headers: { "content-type": "text/html" } },
        )
      return new Response(Bun.file(path.join(directory, pathname)))
    },
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 375, height: 600 }, reducedMotion: "no-preference" })
  page.on("pageerror", (error) => console.error(error))
}, 60000)
afterAll(async () => {
  await browser?.close()
  server?.stop(true)
})
const state = (state: "running" | "committed" | "failed", terminal = false) =>
  page.evaluate(
    ({ state, terminal }) =>
      (window as unknown as { compactionFixture: Fixture }).compactionFixture.state(state, terminal),
    { state, terminal },
  )
const title = () => page.locator('[data-slot="process-event-title"]')
const animation = () => title().evaluate((node) => getComputedStyle(node).animationName)

test("running compaction is a single text line with a looping sweep that ends with the attempt", async () => {
  await page.goto(server.url.href)
  await title().waitFor()
  const button = page.locator('[data-slot="process-event-trigger"]')
  expect(await button.getAttribute("aria-label")).toBe("View details: Compressing context...")
  const icon = button.locator('[data-slot="process-event-icon"]')
  expect(await icon.count()).toBe(1)
  expect(await icon.locator("svg").count()).toBe(1)
  expect(await icon.evaluate((node) => getComputedStyle(node).animationName)).toBe("none")
  expect(await icon.evaluate((node) => node.getBoundingClientRect().width)).toBe(20)
  expect(
    await button.evaluate((node) => {
      const icon = node.querySelector('[data-slot="process-event-icon"]')!.getBoundingClientRect()
      const title = node.querySelector('[data-slot="process-event-title"]')!.getBoundingClientRect()
      return title.left - icon.right
    }),
  ).toBe(8)
  expect(await animation()).not.toBe("none")
  expect(await title().evaluate((node) => getComputedStyle(node).animationIterationCount)).toBe("infinite")
  const position = await title().evaluate((node) => getComputedStyle(node).backgroundPosition)
  await page.waitForTimeout(120)
  expect(await title().evaluate((node) => getComputedStyle(node).backgroundPosition)).not.toBe(position)
  await state("running", true)
  expect(await animation()).not.toBe("none")
  await button.focus()
  await button.press("Enter")
  expect(await button.getAttribute("aria-pressed")).toBe("true")
  await state("committed")
  expect(await animation()).toBe("none")
  expect(await title().textContent()).toBe("Context compressed")
  expect(await icon.locator("svg").count()).toBe(1)
  expect(await page.getByText("Full continuation summary", { exact: true }).count()).toBe(0)
  expect(await button.evaluate((node) => node === document.activeElement)).toBe(true)
  await state("failed")
  expect(await title().textContent()).toBe("Compaction failed")
  expect(await animation()).toBe("none")
  await page.evaluate(() => (window as unknown as { compactionFixture: Fixture }).compactionFixture.replace())
  await page.getByRole("button", { name: "View details: Compressing context...", exact: true }).click()
  expect(
    await page.evaluate(() => (window as unknown as { compactionFixture: Fixture }).compactionFixture.opened()),
  ).toEqual([
    { kind: "compaction", sessionID: "compaction-session", messageID: "attempt-1" },
    { kind: "compaction", sessionID: "compaction-session", messageID: "attempt-2" },
  ])
})

test("compaction remains readable in both themes, reduced motion and forced colors at phone width", async () => {
  await page.goto(server.url.href)
  await title().waitFor()
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate(
      (mode) => (window as unknown as { compactionFixture: Fixture }).compactionFixture.theme(mode),
      mode,
    )
    await page.setViewportSize({ width: 320, height: 600 })
    expect(await title().evaluate((node) => node.getBoundingClientRect().height)).toBe(20)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.emulateMedia({ reducedMotion: "reduce" })
    expect(await animation()).toBe("none")
    expect(await title().evaluate((node) => getComputedStyle(node).color)).not.toBe("rgba(0, 0, 0, 0)")
    await page.emulateMedia({ reducedMotion: "no-preference" })
    expect(await animation()).not.toBe("none")
  }
  await page.emulateMedia({ forcedColors: "active" })
  expect(await animation()).toBe("none")
  expect(await title().evaluate((node) => getComputedStyle(node).color)).not.toBe("rgba(0, 0, 0, 0)")
})

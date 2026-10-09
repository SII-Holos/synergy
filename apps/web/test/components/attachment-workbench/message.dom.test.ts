import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"
import type { ResourceOpenController } from "@ericsanchezok/synergy-ui/context/resource-open"

let browser: Browser, page: Page, server: BrowserFixture
const errors: string[] = []
beforeAll(async () => {
  const root = path.resolve(import.meta.dir, "../../fixtures/attachment-workbench")
  const host = path.join(root, "message-host.tsx")
  server = await createBrowserFixture({
    root,
    entries: ["message.html"],
    styled: true,
    localized: false,
    aliases: [
      { find: "./global-sdk", replacement: host },
      { find: /^@\/context\/(layout|locale|file|sdk|platform|sync)$/, replacement: host },
      { find: "../layout", replacement: host },
      { find: "./platform", replacement: host },
      { find: "@/plugin/host", replacement: host },
      { find: "@/components/dialog/confirm-dialog", replacement: host },
      { find: "@", replacement: path.resolve(import.meta.dir, "../../../src") },
    ],
  })
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(8000)
}, 60000)
afterAll(async () => {
  await browser?.close()
  await server?.close()
})
async function visit(query = "") {
  errors.length = 0
  await page.goto(`${server.url}message.html${query}`)
  await page
    .locator('[data-component="user-message"]')
    .waitFor()
    .catch((error) => {
      throw new Error(`${errors.join("\n")}\n${error}`)
    })
}

test("an invalid structured path keeps its error feedback even when it cannot be copied", async () => {
  await visit()
  const result = await page.evaluate(() =>
    (window as unknown as { openResource: ResourceOpenController["open"] }).openResource(
      { kind: "workspace-file", path: "/fixture/bad\u0000.ts" },
      { context: { state: "bound", workspace: { id: "wsp_fixture", generation: 1, root: "/fixture" }, directory: "" } },
    ),
  )
  expect(result.status).toBe("unavailable")
  await page.getByText("Couldn’t open reference", { exact: true }).waitFor()
  expect(await page.getByRole("button", { name: "Copy reference", exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
})

test.each(["docs/README.md", "docs/notes.txt", "docs/README"])(
  "image syntax for %s opens the file reader",
  async (path) => {
    await page.route("**/workspace/files/stat?**", (route) => route.fulfill({ json: { type: "file", path } }))
    await visit()
    const result = await page.evaluate(
      (path) =>
        (window as unknown as { openResource: ResourceOpenController["open"] }).openResource(
          { kind: "workspace-file", path, mime: "image/*" },
          {
            prefer: "preview",
            context: {
              state: "bound",
              workspace: { id: "wsp_fixture", generation: 1, root: "/fixture" },
              directory: "",
            },
          },
        ),
      path,
    )
    expect(result.status).toBe("opened")
    expect(await page.evaluate(() => (window as unknown as { openedFiles: string[] }).openedFiles)).toEqual([path])
    expect(await page.locator('[data-component="image-preview"]').count()).toBe(0)
    expect(errors).toEqual([])
    await page.unroute("**/workspace/files/stat?**")
  },
)

test("a captured first-send attachment uses the temporary reader until canonical admission", async () => {
  await visit("?preparing")
  const button = page.getByRole("button", { name: "Open portrait.svg", exact: true })
  await button.click()
  await page.locator(".draft-attachment-dialog").waitFor()
  expect(await page.evaluate<number>("window.fixture.tabs().length")).toBe(0)
  await page.getByRole("button", { name: "Zoom in", exact: true }).click()
  expect(await page.locator(".attachment-image-preview").textContent()).toContain("125%")
  expect(await page.getByRole("link", { name: "Download", exact: true }).getAttribute("download")).toBe("portrait.svg")
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open portrait.svg")
  await page.evaluate("window.fixture.admit()")
  await button.press("Enter")
  await page.locator(".attachment-workbench").waitFor()
  expect(await page.evaluate<number>("window.fixture.tabs().length")).toBe(1)
  expect(errors).toEqual([])
})

test.each(["cancel", "navigate", "dispose"])(
  "a temporary attachment reader closes on %s without leaving a tab",
  async (action) => {
    await visit("?preparing")
    await page.getByRole("button", { name: "Open portrait.svg", exact: true }).click()
    await page.locator(".draft-attachment-dialog").waitFor()
    await page.evaluate(
      (action) => (window as unknown as { fixture: Record<string, () => void> }).fixture[action](),
      action,
    )
    await page.locator(".draft-attachment-dialog").waitFor({ state: "detached" })
    expect(await page.evaluate<number>("window.fixture.tabs().length")).toBe(0)
    expect(errors).toEqual([])
  },
)

test("the actual chat button opens the registered reader by pointer, Enter and Space and reuses the resource tab", async () => {
  await visit()
  const button = page.getByRole("button", { name: "Open portrait.svg", exact: true })
  await button.click()
  await page.locator(".attachment-workbench").waitFor()
  for (const key of ["Enter", "Space"]) {
    await button.focus()
    await button.press(key)
  }
  expect(await page.evaluate<number>("window.fixture.tabs().length")).toBe(1)
  expect(await page.getByRole("link", { name: "Download", exact: true }).getAttribute("download")).toBe("portrait.svg")
  await page.getByRole("button", { name: "Zoom in", exact: true }).click()
  expect(await page.locator(".attachment-image-preview").textContent()).toContain("125%")
  expect(errors).toEqual([])
})

test("reader fullscreen and closing retain the original attachment and return focus", async () => {
  await visit()
  const button = page.getByRole("button", { name: "Open portrait.svg", exact: true })
  await button.click()
  await page.locator(".attachment-workbench").waitFor()
  await page.getByRole("button", { name: "Full screen", exact: true }).click()
  expect(await page.getByRole("button", { name: "Exit full screen", exact: true }).getAttribute("aria-pressed")).toBe(
    "true",
  )
  expect(await page.getByRole("link", { name: "Download", exact: true }).getAttribute("download")).toBe("portrait.svg")
  await page.getByRole("button", { name: "Exit full screen", exact: true }).click()
  await page.getByRole("button", { name: "Close portrait.svg", exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open portrait.svg")
  expect(await page.evaluate<number>("window.fixture.tabs().length")).toBe(0)
})

test.each(["throw", "empty"])("a %s open result gives feedback and an actionable retry", async (failure) => {
  await visit(`?failure=${failure}`)
  await page.getByRole("button", { name: "Open portrait.svg", exact: true }).click()
  await page.getByText("Couldn’t open reference", { exact: true }).waitFor()
  await page.evaluate("window.fixture.repair()")
  await page.getByText("Couldn’t open reference", { exact: true }).hover()
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.locator(".attachment-workbench").waitFor()
  expect(errors).toEqual([])
})

test("an unavailable panel gives feedback and a later registration can be retried", async () => {
  await visit("?unregistered")
  await page.getByRole("button", { name: "Open portrait.svg", exact: true }).click()
  await page.getByText("Couldn’t open reference", { exact: true }).waitFor()
  await page.evaluate("window.fixture.repair()")
  await page.getByText("Couldn’t open reference", { exact: true }).hover()
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.locator(".attachment-workbench").waitFor()
  expect(errors).toEqual([])
})

test("switching targets cancels a late opening without a stale error", async () => {
  await visit("?failure=slow")
  await page.getByRole("button", { name: "Open portrait.svg", exact: true }).click()
  await page.evaluate("window.fixture.navigate(); window.fixture.release()")
  await page.waitForTimeout(80)
  expect(await page.evaluate<number>("window.fixture.tabs().length")).toBe(0)
  expect(await page.getByText("Couldn’t open reference", { exact: true }).count()).toBe(0)
  expect(errors).toEqual([])
})

test("single images preserve proportion, while mixed attachments share one metadata row and compact tiles", async () => {
  await visit()
  for (const [width, height] of [
    [320, 160],
    [80, 160],
    [80, 800],
    [100, 100],
  ]) {
    await page.evaluate(
      ([width, height]) =>
        (window as unknown as { fixture: { single(w: number, h: number): void } }).fixture.single(width, height),
      [width, height],
    )
    const image = page.locator('[data-component="attachment-card"] img')
    await image.evaluate((element: HTMLImageElement) => element.decode())
    const box = await page.locator('[data-component="attachment-card"]').boundingBox()
    expect(box!.width / box!.height).toBeCloseTo(width / height, 1)
    expect(box!.width).toBeLessThanOrEqual(240)
    expect(box!.height).toBeLessThanOrEqual(180)
  }
  await visit("?mixed")
  expect(await page.locator('[data-component="attachment-card"][data-type="image"]').boundingBox()).toMatchObject({
    width: 120,
    height: 96,
  })
  expect(await page.locator('[data-slot="user-message-time"]').count()).toBe(1)
  expect(await page.locator('[data-slot="user-message-copy"]').count()).toBe(1)
  expect(await page.locator('[data-slot="user-message-source"]').count()).toBe(1)
  expect(await page.locator(".conversation-display-row").count()).toBe(1)
})

test("attachment and source disclosure survive row remounts at narrow widths in both themes", async () => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await visit("?many")
  const expand = page.getByRole("button", { name: "Expand all 8 attachments" })
  await expand.click()
  await page.getByRole("button", { name: "View source", exact: true }).click()
  await page.evaluate("window.fixture.remount()")
  await page.getByRole("button", { name: "Collapse attachments" }).waitFor()
  expect(await page.getByRole("button", { name: "Markdown", exact: true }).getAttribute("aria-pressed")).toBe("true")
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (mode) => (window as unknown as { fixture: { theme(mode: string): void } }).fixture.theme(mode),
      theme,
    )
    expect(await page.locator('[data-slot="user-message-time"]').count()).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
  }
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
})

test("failed thumbnails try the original and the remaining attachment button opens a retryable reader", async () => {
  let fail = true
  await page.route("**/missing-*", async (route) => {
    if (fail || route.request().url().endsWith("missing-thumbnail")) await route.fulfill({ status: 404 })
    else
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="160"/>',
      })
  })
  await visit()
  await page.evaluate("window.fixture.broken()")
  await page.locator("[data-image-failed]").waitFor()
  await page.getByRole("button", { name: "Open portrait.svg", exact: true }).click()
  await page.getByText("Unable to preview this attachment.", { exact: true }).waitFor()
  fail = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await page.locator(".attachment-image-stage img").waitFor()
  await page.unroute("**/missing-*")
  expect(errors).toEqual([])
})

test("transparent images remain readable and actionable at 200 percent interface zoom", async () => {
  await visit()
  await page.evaluate("window.fixture.transparent(); document.documentElement.style.zoom = '2'")
  const button = page.getByRole("button", { name: "Open portrait.svg", exact: true })
  await button.locator("img").evaluate((image: HTMLImageElement) => image.decode())
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (mode) => (window as unknown as { fixture: { theme(mode: string): void } }).fixture.theme(mode),
      theme,
    )
    const box = await button.boundingBox()
    expect(box!.width).toBeGreaterThan(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(1000)
    expect(await page.locator('[data-slot="user-message-time"]').count()).toBe(1)
    await button.focus()
    await button.press("Enter")
    await page.locator(".attachment-image-stage img").waitFor()
    await page.getByRole("button", { name: "Close portrait.svg", exact: true }).click()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.evaluate("document.documentElement.style.removeProperty('zoom')")
  expect(errors).toEqual([])
})

test.each(["data", "blob"])("%s Markdown images load and open the shared preview", async (scheme) => {
  await visit("?markdown&inline")
  const url = await page.evaluate((scheme) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" onload="document.documentElement.dataset.imageExecuted=1"><rect width="20" height="10" fill="gray"/></svg>'
    const url =
      scheme === "data"
        ? `data:image/svg+xml,${encodeURIComponent(svg)}`
        : URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))
    ;(window as unknown as { fixture: { setMarkdown(value: string): void } }).fixture.setMarkdown(
      `![Inline chart](${url})\n\n`,
    )
    return url
  }, scheme)
  try {
    await page.waitForFunction(
      (url) => document.querySelector('[data-component="markdown"] img')?.getAttribute("src") === url,
      url,
    )
    const image = page.locator('[data-component="markdown"] img').first()
    await image.evaluate((element: HTMLImageElement) => element.decode())
    await image.locator("..").press("Enter")
    await page.locator('[data-component="image-preview"]').waitFor()
    expect(await page.locator('[data-component="image-preview"] img').first().getAttribute("src")).toBe(url)
    expect(await page.getByRole("button", { name: "Open image in new window", exact: true }).count()).toBe(0)
    expect(await page.evaluate(() => document.documentElement.dataset.imageExecuted)).toBeUndefined()
    await page.keyboard.press("Escape")
    expect(errors).toEqual([])
  } finally {
    if (scheme === "blob") await page.evaluate((url) => URL.revokeObjectURL(url), url)
  }
})

test("streamed and completed Markdown references open the shared image preview and document reader", async () => {
  await page.route("**/asset/1111111111111111.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  )
  await page.route("**/asset/2222222222222222.txt", (route) =>
    route.fulfill({ contentType: "text/plain", body: "Captured document verification: APPLE-7319" }),
  )
  await visit("?markdown")
  const image = page.locator('[data-component="markdown"] img').first()
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-component="markdown"] img') as HTMLImageElement
    return image?.complete && image.naturalWidth > 0
  })
  await image.locator("..").focus()
  await page.keyboard.press("Enter")
  await page.locator('[data-component="image-preview"]').waitFor()
  await page.evaluate("window.fixture.setStreaming(false)")
  await page.waitForFunction(
    () => !!document.querySelector('[data-component="markdown"] a[data-resource-bound="true"]'),
  )
  await page.keyboard.press("Escape")
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-resource-reference") === "asset://1111111111111111.png",
  )
  await page.getByRole("button", { name: "Report.txt", exact: true }).focus()
  await page.keyboard.press("Enter")
  await page.locator(".attachment-workbench").waitFor()
  await page.getByText("Captured document verification: APPLE-7319", { exact: false }).waitFor()
  expect(await page.getByRole("link", { name: "Download", exact: true }).getAttribute("href")).toBe(
    `${server.url}asset/2222222222222222.txt`,
  )
  await page.getByRole("button", { name: "Close Report.txt", exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.textContent === "Report.txt")
  expect(errors).toEqual([])
  await page.unroute("**/asset/1111111111111111.png")
  await page.unroute("**/asset/2222222222222222.txt")
}, 15000)

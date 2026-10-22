import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let directory: string
let fixture: BrowserFixture
let browser: Browser

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".toolbar-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `import { render } from "solid-js/web"
    import { LocaleProvider } from "@/context/locale"
    import { SelectionToolbar } from "@/components/text-selection/selection-toolbar"
    import { textSelectionController } from "@/context/text-selection"
    import { registerQuoteTarget } from "@/components/prompt-input/quote-target"
    import { configureClipboard } from "@ericsanchezok/synergy-ui/clipboard"
    const state = { copied: [] as string[], quotes: [] as unknown[], delayed: false, pending: false,
      finish: () => {} }
    Object.assign(window, { selectionFixture: state })
    const pending = () => new Promise<void>(resolve => {
      state.pending = true
      state.finish = () => { state.pending = false; resolve() }
    })
    configureClipboard({ writer: async text => {
      state.copied.push(text)
      if (state.delayed) await pending()
    } })
    registerQuoteTarget({ available: () => true, accept: value => state.quotes.push(value) })
    textSelectionController.registerAction({ id: "fixture:action", pluginId: "fixture", pluginName: "Fixture",
      label: "Delayed action", order: 0, run: pending })
    render(() => <LocaleProvider>
      <div data-message-role="assistant"><div data-message="first"><p id="first">First reply</p></div></div>
      <div data-message-role="assistant"><div data-message="second"><p id="second">Second reply</p></div></div>
      <SelectionToolbar />
    </LocaleProvider>, document.getElementById("root")!)`,
  )
  fixture = await createBrowserFixture({
    root: directory,
    localized: true,
    aliases: [{ find: "@", replacement: path.resolve(import.meta.dir, "../../../src") }],
  })
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await fixture?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

type State = { copied: string[]; quotes: unknown[]; delayed: boolean; pending: boolean; finish(): void }
declare global {
  interface Window {
    selectionFixture: State
  }
}

async function select(page: Page, id: string) {
  await page.locator(`#${id}`).click()
  await page.locator(`#${id}`).evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.locator('[data-component="selection-toolbar"]').waitFor()
}

test("a transcript selection uses the shared clipboard and quote owners", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await select(page, "first")
    await page.locator('[data-action="copy"]').click()
    expect(await page.evaluate(() => window.selectionFixture.copied)).toEqual(["First reply"])
    await select(page, "second")
    await page.locator('[data-action="quote"]').click()
    expect(await page.evaluate(() => window.selectionFixture.quotes)).toEqual([
      { text: "Second reply", role: "assistant" },
    ])
  } finally {
    await page.close()
  }
})

test.each(["copy", "fixture:action"])("late %s completion cannot dismiss a newer selection", async (action) => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.evaluate(() => {
      window.selectionFixture.delayed = true
    })
    await select(page, "first")
    await page.locator(`[data-action="${action}"]`).click()
    await page.waitForFunction(() => window.selectionFixture.pending)
    await select(page, "second")
    await page.evaluate(async () => {
      window.selectionFixture.finish()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
    expect(await page.locator('[data-component="selection-toolbar"]').isVisible()).toBe(true)
    await page.locator('[data-action="quote"]').click()
    expect(await page.evaluate(() => window.selectionFixture.quotes)).toEqual([
      { text: "Second reply", role: "assistant" },
    ])
  } finally {
    await page.close()
  }
})

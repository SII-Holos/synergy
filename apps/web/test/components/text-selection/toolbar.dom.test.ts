import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createBrowserFixture, type BrowserFixture } from "../../support/browser-fixture"

let directory: string
let fixture: BrowserFixture
let browser: Browser

const mathPassage = `它不是我们额外设定的超参数，而是 $\\mathcal{D}$ 的分解：

$$
w_g = \\Pr_{x\\sim\\mathcal{D}}[g(x)=g],\\quad \\mathcal{D}_g=\\mathcal{D}(\\cdot\\mid g(x)=g)
$$

所以 $\\mathcal{D}=\\sum_g w_g\\mathcal{D}_g$ 只是全概率公式，总体价值同理可以拆成 $J(c)=\\sum_g w_gJ_g(c)$。`

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".toolbar-"))
  await Bun.write(
    path.join(directory, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>',
  )
  await Bun.write(
    path.join(directory, "main.tsx"),
    `import { render } from "solid-js/web"
    import { LocaleProvider } from "@/context/locale"
    import { SelectionToolbar } from "@/components/text-selection/selection-toolbar"
    import { textSelectionController } from "@/context/text-selection"
    import { registerQuoteTarget } from "@/components/prompt-input/quote-target"
    import { configureClipboard } from "@ericsanchezok/synergy-ui/clipboard"
    import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
    import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
    import { ResourceOpenProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
    import "@ericsanchezok/synergy-ui/styles"
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
      <MarkedProvider><ResourceOpenProvider value={{ open: async () => ({ status: "opened" }) }}>
        <div data-message-role="assistant"><div data-message="math" id="math"><Markdown text={${JSON.stringify(mathPassage)}} /></div></div>
      </ResourceOpenProvider></MarkedProvider>
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
  await page.locator(`#${id}`).click({ position: { x: 1, y: 1 } })
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

test("copy and quote preserve paragraphs and serialize each rendered formula once", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.locator("#math .katex-display").waitFor()
    await select(page, "math")
    await page.locator('[data-action="copy"]').click()
    expect(await page.evaluate(() => window.selectionFixture.copied)).toEqual([mathPassage])
    await select(page, "math")
    await page.locator('[data-action="quote"]').click()
    expect(await page.evaluate(() => window.selectionFixture.quotes)).toEqual([
      { text: mathPassage, role: "assistant" },
    ])
  } finally {
    await page.close()
  }
})

test("keyboard copy uses the same math text without changing the selection", async () => {
  const page = await browser.newPage()
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await page.goto(fixture.url)
    await page.locator("#math .katex-display").waitFor()
    await select(page, "math")
    const selected = await page.evaluate(() => window.getSelection()!.toString())
    await page.keyboard.press("ControlOrMeta+c")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mathPassage)
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected)
  } finally {
    await page.close()
  }
})

test("native copy retains ownership for plain text, editors and excluded content", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(fixture.url)
    await page.locator("#math .katex-display").waitFor()
    const intercepted = await page.evaluate(() => {
      const selection = window.getSelection()!
      const selectContents = (element: Element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      const copy = () => {
        const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })
        document.dispatchEvent(event)
        return event.defaultPrevented
      }
      selectContents(document.getElementById("first")!)
      const plain = copy()
      const math = document.getElementById("math")!
      selectContents(math)
      math.setAttribute("contenteditable", "true")
      const editor = copy()
      math.removeAttribute("contenteditable")
      const input = document.createElement("textarea")
      input.value = "source text"
      document.body.append(input)
      input.focus()
      input.select()
      const textarea = copy()
      input.remove()
      selectContents(math)
      math.querySelector("p")!.setAttribute("data-selection-excluded", "")
      const excluded = copy()
      return { plain, editor, textarea, excluded }
    })
    expect(intercepted).toEqual({ plain: false, editor: false, textarea: false, excluded: false })
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

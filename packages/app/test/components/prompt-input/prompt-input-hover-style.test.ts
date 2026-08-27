import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"

const css = await Bun.file(new URL("../../../src/index.css", import.meta.url)).text()
// index.css leads with an `@import` that sits after the `:root` block above,
// so the import is ignored per CSS spec inside this harness; the assertions
// below only rely on the rules that follow it.

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent(`
    <style>
      :root {
        --text-strong: rgb(240 240 242);
      }
      ${css}
    </style>
    <div
      class="synergy-workbench-canvas"
      style="--workbench-input-bg: rgb(34 35 39); --workbench-input-bg-hover: rgb(42 43 47);"
    >
      <div class="prompt-input-shell" style="width: 480px; padding: 12px">
        <div class="prompt-input-toolbar">
          <button type="button" class="prompt-input-toolbar-button">Synergy Max</button>
        </div>
      </div>
    </div>
  `)
})

afterAll(async () => {
  await browser?.close()
})

describe("prompt input hover feedback", () => {
  test("does not light up the whole shell on hover; focus owns that feedback", async () => {
    const shell = page.locator(".prompt-input-shell")
    const before = await shell.evaluate((element) => getComputedStyle(element).backgroundColor)
    await shell.hover()
    await page.waitForTimeout(250)
    const afterHover = await shell.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(afterHover).toBe(before)
  })

  test("keeps discrete toolbar control hover affordance", async () => {
    const control = page.locator(".prompt-input-toolbar-button")
    const before = await control.evaluate((element) => getComputedStyle(element).backgroundColor)
    await control.hover()
    await page.waitForTimeout(250)
    const afterHover = await control.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(afterHover).not.toBe(before)
  })
})

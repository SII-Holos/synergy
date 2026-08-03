import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser } from "playwright"

const css = await Bun.file(new URL("../../../src/components/session/question-prompt.css", import.meta.url)).text()
let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

describe("question prompt selected option", () => {
  test("keeps the selection marker neutral and theme-polarized", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 300 } })
    try {
      await page.setContent(`
        <style>${css}</style>
        <div
          id="light"
          style="
            --text-strong: #030712;
            --surface-inset-strong-hover: #eaeaed;
            --workbench-selected-bg: #f1f2f4;
          "
        >
          <button class="question-prompt-option is-picked">
            <span class="question-prompt-option-mark">✓</span>
          </button>
        </div>
        <div
          id="dark"
          style="
            --text-strong: #fafafa;
            --surface-inset-strong-hover: #303137;
            --workbench-selected-bg: #2a2b2f;
          "
        >
          <button class="question-prompt-option is-picked">
            <span class="question-prompt-option-mark">✓</span>
          </button>
        </div>
      `)

      for (const expected of [
        { id: "light", backgroundColor: "rgb(234, 234, 237)", color: "rgb(3, 7, 18)" },
        { id: "dark", backgroundColor: "rgb(48, 49, 55)", color: "rgb(250, 250, 250)" },
      ]) {
        const style = await page.locator(`#${expected.id} .question-prompt-option-mark`).evaluate((element) => {
          const computed = getComputedStyle(element)
          return {
            backgroundColor: computed.backgroundColor,
            color: computed.color,
          }
        })
        expect(style).toEqual({
          backgroundColor: expected.backgroundColor,
          color: expected.color,
        })
      }
    } finally {
      await page.close()
    }
  })
})

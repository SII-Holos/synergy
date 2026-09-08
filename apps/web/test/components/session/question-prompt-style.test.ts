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

describe("question prompt disclosure layout", () => {
  test("expanded content stays scrollable inside the constrained shell (tall prompt)", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
    try {
      await page.setContent(`
        <style>*, ::before, ::after { box-sizing: border-box; } ${css}</style>
        <section class="question-prompt-shell" style="max-height: 300px">
          <div class="question-prompt-expanded-shell is-open">
            <div class="question-prompt-expanded">
              <div class="question-prompt-content" style="min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 9px;">
                <div style="height: 600px; flex: none;">tall content</div>
              </div>
            </div>
          </div>
        </section>
      `)

      const metrics = await page.locator(".question-prompt-expanded").evaluate((element) => {
        const shell = element.closest(".question-prompt-shell")!
        const content = element.querySelector<HTMLElement>(".question-prompt-content")!
        return {
          shellHeight: shell.getBoundingClientRect().height,
          expandedHeight: element.getBoundingClientRect().height,
          contentClientHeight: content.clientHeight,
          contentScrollHeight: content.scrollHeight,
        }
      })

      // The expanded shell must shrink to fit the max-height shell (not overflow it),
      // leaving the inner content area as the scroll container.
      expect(metrics.expandedHeight).toBeLessThanOrEqual(metrics.shellHeight)
      expect(metrics.contentScrollHeight).toBeGreaterThan(metrics.contentClientHeight)
    } finally {
      await page.close()
    }
  })
})

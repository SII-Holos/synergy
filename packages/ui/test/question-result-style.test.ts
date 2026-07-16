import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"

let browser: Browser | undefined
let page: Page
let messagePartCss: string

beforeAll(async () => {
  messagePartCss = await Bun.file(new URL("../src/components/message-part.css", import.meta.url)).text()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
})

afterAll(async () => {
  await browser?.close()
})

describe("question tool result styles", () => {
  test("keeps question hierarchy explicit in light and dark themes", async () => {
    await page.setContent(`
      <style>
        ${messagePartCss}
      </style>
      <div
        id="light"
        style="
          width: 480px;
          --font-size-small: 14px;
          --font-size-base: 16px;
          --font-weight-regular: 400;
          --font-weight-medium: 500;
          --line-height-large: 1.5;
          --text-base: #111827;
          --text-weak: #374151;
          --text-weaker: #6b7280;
          --surface-inset-base: #f4f4f5;
          --border-weaker-base: #d1d5db;
        "
      >
        <div data-component="tool-output">
          <div data-slot="question-item">
            <div data-slot="question-header">Scope</div>
            <div data-slot="question-text">Which environment should receive the deployment?</div>
            <div data-slot="question-answer">→ Staging</div>
          </div>
        </div>
      </div>
      <div
        id="dark"
        style="
          width: 480px;
          --font-size-small: 14px;
          --font-size-base: 16px;
          --font-weight-regular: 400;
          --font-weight-medium: 500;
          --line-height-large: 1.5;
          --text-base: #f4f4f5;
          --text-weak: #d4d4d8;
          --text-weaker: #a1a1aa;
          --surface-inset-base: #222326;
          --border-weaker-base: #3f3f46;
        "
      >
        <div data-component="tool-output">
          <div data-slot="question-item">
            <div data-slot="question-header">Scope</div>
            <div data-slot="question-text">Which environment should receive the deployment?</div>
            <div data-slot="question-answer">→ Staging</div>
          </div>
        </div>
      </div>
    `)

    for (const contract of [
      {
        id: "light",
        header: "rgb(107, 114, 128)",
        prompt: "rgb(17, 24, 39)",
        answer: "rgb(55, 65, 81)",
      },
      {
        id: "dark",
        header: "rgb(161, 161, 170)",
        prompt: "rgb(244, 244, 245)",
        answer: "rgb(212, 212, 216)",
      },
    ]) {
      const styles = await page.locator(`#${contract.id} [data-slot="question-item"]`).evaluate((item) => {
        const read = (slot: string) => {
          const element = item.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
          if (!element) throw new Error(`Missing ${slot}`)
          const style = getComputedStyle(element)
          return {
            color: style.color,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
          }
        }
        const itemStyle = getComputedStyle(item)
        return {
          item: {
            display: itemStyle.display,
            flexDirection: itemStyle.flexDirection,
            gap: itemStyle.gap,
            paddingTop: itemStyle.paddingTop,
          },
          header: read("question-header"),
          prompt: read("question-text"),
          answer: read("question-answer"),
        }
      })

      expect(styles.item).toEqual({
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        paddingTop: "4px",
      })
      expect(styles.header).toEqual({
        color: contract.header,
        fontSize: "14px",
        fontWeight: "500",
        lineHeight: "21px",
      })
      expect(styles.prompt).toEqual({
        color: contract.prompt,
        fontSize: "16px",
        fontWeight: "400",
        lineHeight: "24px",
      })
      expect(styles.answer).toEqual({
        color: contract.answer,
        fontSize: "14px",
        fontWeight: "500",
        lineHeight: "21px",
      })
    }
  })
})

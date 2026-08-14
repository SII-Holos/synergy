import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"

let browser: Browser
let page: Page

beforeAll(async () => {
  const componentRoot = path.resolve(import.meta.dir, "../../src/components")
  const css = await Promise.all(
    ["collapsible.css", "activity-trace.css", "error-card.css"].map((file) =>
      Bun.file(path.join(componentRoot, file)).text(),
    ),
  )

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.setContent(`
    <style>
      :root {
        --surface-critical-weak: rgb(72 16 20);
        --surface-raised-base: rgb(28 28 30);
        --surface-raised-base-hover: rgb(36 36 38);
        --surface-base-hover: rgb(38 38 40);
        --border-critical-base: rgb(206 70 76);
        --border-weaker-base: rgb(72 72 76);
        --text-base: rgb(240 240 242);
        --text-weak: rgb(184 184 190);
        --text-subtle: rgb(144 144 150);
        --icon-critical-base: rgb(236 94 100);
        --icon-weak: rgb(152 152 158);
        --radius-sm: 6px;
        --radius-md: 8px;
        --motion-duration-fast: 120ms;
        --motion-duration-base: 160ms;
        --motion-ease-standard: ease;
      }
      ${css.join("\n")}
    </style>
    <div data-component="activity-trace" style="width: 800px; margin: 0">
      <ol data-slot="activity-step-list">
        <li data-slot="activity-step" data-family="execute" data-state="error">
          <div data-component="collapsible" data-variant="ghost" data-expanded>
            <button data-slot="activity-step-trigger" type="button">Run command</button>
            <div data-slot="collapsible-content" data-expanded>
              <div data-component="tool-result-body" data-presentation="result">
                <div data-component="error-card" data-expanded>
                  <div data-component="collapsible" data-variant="ghost" data-expanded>
                    <button data-slot="error-card-header" type="button">Permission denied</button>
                    <div data-slot="collapsible-content" data-expanded>
                      <div data-slot="error-card-content">
                        <div data-slot="error-card-label">Error details</div>
                        <pre data-slot="error-card-text">Blocked by policy</pre>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </li>
      </ol>
    </div>
  `)
})

afterAll(async () => {
  await browser?.close()
})

describe("activity trace expanded details", () => {
  test("aligns the expanded tool result with the activity row", async () => {
    const positions = await page.evaluate(() => {
      const trigger = document.querySelector('[data-slot="activity-step-trigger"]')!.getBoundingClientRect()
      const result = document.querySelector('[data-component="tool-result-body"]')!.getBoundingClientRect()
      return { triggerLeft: trigger.left, resultLeft: result.left }
    })

    expect(positions.resultLeft).toBe(positions.triggerLeft)
  })

  test("keeps the error card surface neutral while reserving red for status accents", async () => {
    const backgroundColor = await page
      .locator('[data-component="error-card"]')
      .evaluate((element) => getComputedStyle(element).backgroundColor)

    expect(backgroundColor).toBe("rgb(28, 28, 30)")
  })

  test("balances the error card content padding with the card edge", async () => {
    const padding = await page.locator('[data-slot="error-card-content"]').evaluate((element) => {
      const style = getComputedStyle(element)
      return { left: style.paddingLeft, right: style.paddingRight }
    })

    expect(padding.left).toBe(padding.right)
  })
})

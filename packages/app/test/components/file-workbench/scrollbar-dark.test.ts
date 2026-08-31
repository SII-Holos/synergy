import { describe, expect, test } from "bun:test"
import { chromium } from "playwright"

const stylesUrl = new URL("../../../src/components/file-workbench/styles.css", import.meta.url)

describe("file workbench markdown preview dark scrollbar", () => {
  test("explicit dark scheme raises the webkit thumb to a visible white mix", async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 480, height: 320 }, colorScheme: "dark" })
      const styles = await Bun.file(stylesUrl).text()
      await page.setContent(`
        <style>
          :root {
            --text-strong: #FAFAFA;
            --border-weaker-base: #F4F4F50D;
            --border-weak-base: #F4F4F514;
          }
          ::-webkit-scrollbar { width: 14px; height: 14px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb {
            background-color: var(--border-weaker-base);
            border-radius: 9999px;
            border: 4px solid transparent;
            background-clip: padding-box;
          }
          ::-webkit-scrollbar-thumb:hover { background-color: var(--border-weak-base); }
          ${styles}
        </style>
        <div class="file-markdown-preview"><p>content</p></div>
      `)
      await page.evaluate(() => document.documentElement.setAttribute("data-color-scheme", "dark"))

      const thumbBackgrounds = await page.evaluate(() => {
        const results: string[] = []
        const collect = (rules: CSSRuleList) => {
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSStyleRule && rule.selectorText.includes("::-webkit-scrollbar-thumb")) {
              results.push(rule.style.backgroundColor)
            }
            if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) collect(rule.cssRules)
          }
        }
        for (const sheet of Array.from(document.styleSheets)) collect(sheet.cssRules)
        return results
      })

      expect(
        thumbBackgrounds.some((background) => background.includes("55%")),
        `expected a dark-mode 55% thumb rule, got ${JSON.stringify(thumbBackgrounds)}`,
      ).toBe(true)
      expect(thumbBackgrounds.some((background) => background.includes("70%"))).toBe(true)
    } finally {
      await browser.close()
    }
  })
})

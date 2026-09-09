import { describe, expect, test } from "bun:test"
import { chromium } from "playwright"

const stylesUrl = new URL("../../../src/components/file-workbench/styles.css", import.meta.url)

// Chromium serializes a computed color-mix(...) as `color(srgb r g b / alpha)`.
function thumbAlpha(scrollbarColor: string): string | null {
  return scrollbarColor.match(/\/\s*([0-9.]+)/)?.[1] ?? null
}

async function computedScrollbarColor(scheme: "light" | "dark") {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 320 } })
    const styles = await Bun.file(stylesUrl).text()
    const textStrong = scheme === "dark" ? "#FAFAFA" : "#030712"
    await page.setContent(`
      <style>
        :root { --text-strong: ${textStrong}; }
        ${styles}
      </style>
      <div class="file-markdown-preview"><p>content</p></div>
    `)
    if (scheme === "dark") {
      await page.evaluate(() => document.documentElement.setAttribute("data-color-scheme", "dark"))
    }
    return await page.evaluate(() => getComputedStyle(document.querySelector(".file-markdown-preview")!).scrollbarColor)
  } finally {
    await browser.close()
  }
}

describe("file workbench markdown preview scrollbar", () => {
  test("light scheme tints the thumb at 34% text-strong via scrollbar-color", async () => {
    const value = await computedScrollbarColor("light")
    // scrollbar-color is the only effective thumb style: ::-webkit-scrollbar-*
    // pseudo-elements are ignored once scrollbar-color is non-auto.
    expect(thumbAlpha(value)).toBe("0.34")
  })

  test("explicit dark scheme raises the thumb to 55% text-strong", async () => {
    const value = await computedScrollbarColor("dark")
    expect(thumbAlpha(value)).toBe("0.55")
  })

  test("stylesheet carries no dead ::-webkit-scrollbar-* rules for the preview container", async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const styles = await Bun.file(stylesUrl).text()
      await page.setContent(`
        <style>
          :root { --text-strong: #030712; }
          ${styles}
        </style>
        <div class="file-markdown-preview"><p>content</p></div>
      `)
      const previewWebkitRules = await page.evaluate(() => {
        for (const sheet of Array.from(document.styleSheets)) {
          for (const rule of Array.from(sheet.cssRules)) {
            if (
              rule instanceof CSSStyleRule &&
              rule.selectorText.includes(".file-markdown-preview") &&
              rule.selectorText.includes("::-webkit-scrollbar")
            ) {
              return rule.selectorText
            }
          }
        }
        return null
      })
      expect(previewWebkitRules).toBeNull()
    } finally {
      await browser.close()
    }
  })
})

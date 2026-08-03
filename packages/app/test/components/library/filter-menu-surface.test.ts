import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { chromium, type Browser } from "playwright"

const libraryCss = await readFile(new URL("../../../src/components/library/library-panel.css", import.meta.url), "utf8")
const themeCss = await readFile(new URL("../../../../ui/src/styles/theme.generated.css", import.meta.url), "utf8")

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

function relativeLuminance(color: string) {
  const channels = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number)
  if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${color}`)
  const linear = channels.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

async function readMenuStyles(colorScheme: "light" | "dark") {
  const page = await browser.newPage({ colorScheme })
  try {
    await page.setContent(`
      <style>${themeCss}\n${libraryCss}\n.library-menu-item { transition: none; }</style>
      <div class="library-workbench"></div>
      <div class="library-menu-surface">
        <button class="library-menu-item is-active">Selected</button>
        <button class="library-menu-item menu-hover-target">Hover</button>
      </div>
    `)
    await page.locator(".menu-hover-target").hover()
    return await page.locator(".library-menu-surface").evaluate((menu) => {
      const menuStyle = getComputedStyle(menu)
      const activeStyle = getComputedStyle(menu.querySelector(".is-active")!)
      const hoverStyle = getComputedStyle(menu.querySelector(".menu-hover-target")!)
      return {
        menuBackground: menuStyle.backgroundColor,
        activeBackground: activeStyle.backgroundColor,
        hoverBackground: hoverStyle.backgroundColor,
        borderStyle: menuStyle.borderTopStyle,
        borderWidth: menuStyle.borderTopWidth,
      }
    })
  } finally {
    await page.close()
  }
}

describe("Library filter menu surface", () => {
  test("keeps portaled filters grounded with theme-correct inward polarity", async () => {
    const light = await readMenuStyles("light")
    const dark = await readMenuStyles("dark")

    for (const styles of [light, dark]) {
      expect(styles.menuBackground).not.toBe("rgba(0, 0, 0, 0)")
      expect(styles.activeBackground).not.toBe("rgba(0, 0, 0, 0)")
      expect(styles.hoverBackground).not.toBe("rgba(0, 0, 0, 0)")
      expect(styles.borderStyle).toBe("solid")
      expect(styles.borderWidth).toBe("1px")
    }

    expect(relativeLuminance(light.hoverBackground)).toBeLessThan(relativeLuminance(light.menuBackground))
    expect(relativeLuminance(light.activeBackground)).toBeLessThan(relativeLuminance(light.menuBackground))
    expect(relativeLuminance(dark.hoverBackground)).toBeGreaterThan(relativeLuminance(dark.menuBackground))
    expect(relativeLuminance(dark.activeBackground)).toBeGreaterThan(relativeLuminance(dark.menuBackground))
  })
})

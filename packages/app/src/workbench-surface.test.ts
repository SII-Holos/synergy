import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

type Rgb = [number, number, number]

const css = await Bun.file(new URL("./index.css", import.meta.url)).text()
const settingsCss = await Bun.file(new URL("./components/settings/settings-panel.css", import.meta.url)).text()
const appSrc = fileURLToPath(new URL(".", import.meta.url))
const uiSrc = fileURLToPath(new URL("../../ui/src", import.meta.url))

function parseLightDarkToken(source: string, name: string, mode: "light" | "dark"): Rgb {
  const pattern = new RegExp(
    `--${name}:\\s*light-dark\\(rgb\\((\\d+) (\\d+) (\\d+)\\), rgb\\((\\d+) (\\d+) (\\d+)\\)\\);`,
  )
  const match = source.match(pattern)
  if (!match) throw new Error(`Missing token: ${name}`)
  const offset = mode === "light" ? 1 : 4
  return [Number(match[offset]), Number(match[offset + 1]), Number(match[offset + 2])]
}

function parseWorkbenchToken(name: string, mode: "light" | "dark"): Rgb {
  return parseLightDarkToken(css, name, mode)
}

function parseSettingsToken(name: string, mode: "light" | "dark"): Rgb {
  return parseLightDarkToken(settingsCss, name, mode)
}

function luminance([r, g, b]: Rgb) {
  const channels = [r, g, b].map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function walkSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filepath = join(dir, entry.name)
    if (entry.isDirectory()) return walkSourceFiles(filepath)
    if (!/\.(css|ts|tsx)$/.test(filepath)) return []
    try {
      return statSync(filepath).isFile() ? [filepath] : []
    } catch {
      return []
    }
  })
}

function escapeClassName(className: string) {
  return `.${className.replace(/:/g, "\\:").replace(/\//g, "\\/")}`
}

describe("workbench surface polarity", () => {
  const tokenOrder = [
    "workbench-canvas-bg",
    "workbench-panel-bg",
    "workbench-card-bg",
    "workbench-card-secondary-bg",
    "workbench-control-bg",
    "workbench-input-bg",
    "workbench-selected-bg",
  ]

  test("light mode steps inward by getting darker", () => {
    const values = tokenOrder.map((name) => luminance(parseWorkbenchToken(name, "light")))
    for (let i = 0; i < values.length - 1; i++) {
      expect(values[i + 1]).toBeLessThan(values[i])
    }
  })

  test("dark mode steps inward by getting brighter", () => {
    const values = tokenOrder.map((name) => luminance(parseWorkbenchToken(name, "dark")))
    for (let i = 0; i < values.length - 1; i++) {
      expect(values[i + 1]).toBeGreaterThan(values[i])
    }
  })

  test("opaque workbench mappings include common translucent surface utilities", () => {
    for (const className of [
      ".bg-surface-raised-base\\/80",
      ".bg-surface-inset-base\\/70",
      ".bg-surface-interactive-base\\/8",
      ".bg-background-base\\/55",
      ".hover\\:bg-surface-inset-base\\/40:hover",
    ]) {
      expect(css).toContain(className)
    }
  })

  test("settings uses the same secondary and popover direction instead of flattening them", () => {
    expect(settingsCss).toContain("--settings-card-secondary-bg: light-dark(rgb(224 228 233), rgb(44 44 47));")
    expect(settingsCss).toContain("--settings-popover-bg: light-dark(rgb(226 230 235), rgb(46 46 49));")
    expect(settingsCss).toContain("--workbench-card-secondary-bg: var(--settings-card-secondary-bg);")
    expect(settingsCss).toContain("--workbench-popover-bg: var(--settings-popover-bg);")
    expect(settingsCss).not.toContain("--workbench-card-secondary-bg: var(--settings-card-bg);")
    expect(settingsCss).not.toContain("--workbench-popover-bg: var(--settings-panel-bg);")
  })

  test("secondary, popover, hover, and selected layers preserve mode-aware direction", () => {
    const relationships = [
      ["workbench-panel-bg", "workbench-canvas-bg"],
      ["workbench-card-bg", "workbench-panel-bg"],
      ["workbench-card-secondary-bg", "workbench-card-bg"],
      ["workbench-card-bg-hover", "workbench-card-bg"],
      ["workbench-control-bg", "workbench-card-bg"],
      ["workbench-control-bg-hover", "workbench-control-bg"],
      ["workbench-input-bg", "workbench-card-bg"],
      ["workbench-input-bg-hover", "workbench-input-bg"],
      ["workbench-selected-bg", "workbench-control-bg"],
      ["workbench-selected-bg-hover", "workbench-selected-bg"],
      ["workbench-popover-bg", "workbench-card-bg"],
    ] as const

    for (const [inner, outer] of relationships) {
      expect(luminance(parseWorkbenchToken(inner, "light"))).toBeLessThan(
        luminance(parseWorkbenchToken(outer, "light")),
      )
      expect(luminance(parseWorkbenchToken(inner, "dark"))).toBeGreaterThan(
        luminance(parseWorkbenchToken(outer, "dark")),
      )
    }
  })

  test("settings scoped tokens preserve the same inward direction", () => {
    const relationships = [
      ["settings-panel-bg", "settings-canvas-bg"],
      ["settings-card-bg", "settings-panel-bg"],
      ["settings-card-secondary-bg", "settings-card-bg"],
      ["settings-popover-bg", "settings-card-bg"],
      ["settings-control-bg", "settings-card-bg"],
      ["settings-input-bg", "settings-card-bg"],
      ["settings-selected-bg", "settings-control-bg"],
    ] as const

    for (const [inner, outer] of relationships) {
      expect(luminance(parseSettingsToken(inner, "light"))).toBeLessThan(luminance(parseSettingsToken(outer, "light")))
      expect(luminance(parseSettingsToken(inner, "dark"))).toBeGreaterThan(luminance(parseSettingsToken(outer, "dark")))
    }
  })

  test("raised stronger non-alpha utilities resolve to popover surfaces inside the workbench", () => {
    expect(css).toContain(".bg-surface-raised-stronger-non-alpha")
    expect(css).toContain("background-color: var(--workbench-popover-bg);")
    expect(css).not.toContain(
      ".bg-surface-raised-stronger-non-alpha\n  ) {\n  background-color: var(--workbench-card-bg);",
    )
  })

  test("generic surface utilities used by the frontend are covered by workbench mappings", () => {
    const sourceFiles = [...walkSourceFiles(appSrc), ...walkSourceFiles(uiSrc)]
    const genericBgClass = /(?:^|[\s"'`])((?:hover:)?bg-(?:surface|background|input|button)-[A-Za-z0-9\-/]+)/g
    const semanticState =
      /success|warning|critical|info|diff|action|brand|interactive-solid|interactive-weak|interactive-hover|muted|disabled/
    const missing = new Set<string>()

    for (const filepath of sourceFiles) {
      const source = readFileSync(filepath, "utf8")
      let match: RegExpExecArray | null
      while ((match = genericBgClass.exec(source))) {
        const className = match[1]
        if (semanticState.test(className)) continue
        const selector = escapeClassName(className)
        if (css.includes(selector) || css.includes(`${selector}:hover`)) continue
        missing.add(className)
      }
    }

    expect([...missing].sort()).toEqual([])
  })
})

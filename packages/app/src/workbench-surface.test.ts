import { describe, expect, test } from "bun:test"

type Rgb = [number, number, number]

const css = await Bun.file(new URL("./index.css", import.meta.url)).text()
const settingsCss = await Bun.file(new URL("./components/settings/settings-panel.css", import.meta.url)).text()

function parseWorkbenchToken(name: string, mode: "light" | "dark"): Rgb {
  const pattern = new RegExp(
    `--${name}:\\s*light-dark\\(rgb\\((\\d+) (\\d+) (\\d+)\\), rgb\\((\\d+) (\\d+) (\\d+)\\)\\);`,
  )
  const match = css.match(pattern)
  if (!match) throw new Error(`Missing workbench token: ${name}`)
  const offset = mode === "light" ? 1 : 4
  return [Number(match[offset]), Number(match[offset + 1]), Number(match[offset + 2])]
}

function luminance([r, g, b]: Rgb) {
  const channels = [r, g, b].map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
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

  test("settings uses the same secondary surface direction instead of flattening it", () => {
    expect(settingsCss).toContain("--settings-card-secondary-bg: light-dark(rgb(224 228 233), rgb(44 44 47));")
    expect(settingsCss).toContain("--workbench-card-secondary-bg: var(--settings-card-secondary-bg);")
    expect(settingsCss).not.toContain("--workbench-card-secondary-bg: var(--settings-card-bg);")
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
      ["workbench-popover-bg", "workbench-canvas-bg"],
    ] as const

    for (const [inner, outer] of relationships) {
      expect(luminance(parseWorkbenchToken(inner, "light"))).toBeLessThan(luminance(parseWorkbenchToken(outer, "light")))
      expect(luminance(parseWorkbenchToken(inner, "dark"))).toBeGreaterThan(luminance(parseWorkbenchToken(outer, "dark")))
    }
  })
})

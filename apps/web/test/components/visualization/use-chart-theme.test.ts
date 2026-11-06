import { describe, expect, test } from "bun:test"
import { resolveTheme, synergyTheme } from "@ericsanchezok/synergy-ui/theme"
import { createChartTheme } from "../../../src/components/visualization/use-chart-theme"

describe("Chart.js skin adapter", () => {
  test("provides every imperative color surface for both theme variants", () => {
    const resolved = resolveTheme(synergyTheme)
    const light = createChartTheme(resolved.light)
    const dark = createChartTheme(resolved.dark)

    for (const skin of [light, dark]) {
      expect(skin.series).toHaveLength(9)
      expect(skin.legend.labels.color).toMatch(/^#/)
      expect(skin.tooltip).toMatchObject({
        backgroundColor: expect.stringMatching(/^#/),
        borderColor: expect.stringMatching(/^#/),
        titleColor: expect.stringMatching(/^#/),
        bodyColor: expect.stringMatching(/^#/),
        footerColor: expect.stringMatching(/^#/),
      })
      expect(skin.point).toMatchObject({
        pointBackgroundColor: expect.stringMatching(/^#/),
        pointBorderColor: expect.stringMatching(/^#/),
        pointHoverBackgroundColor: expect.stringMatching(/^#/),
        pointHoverBorderColor: expect.stringMatching(/^#/),
      })
      expect(Object.values(skin.states).every((color) => color.startsWith("#"))).toBe(true)
    }
    expect(dark.tooltip.backgroundColor).not.toBe(light.tooltip.backgroundColor)
    expect(dark.axis).not.toBe(light.axis)
  })
})

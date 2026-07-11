import { createMemo } from "solid-js"
import { resolveThemeColor, useTheme, withAlpha, type ThemeTokenName } from "@ericsanchezok/synergy-ui/theme"

export function useChartTheme() {
  const theme = useTheme()

  return createMemo(() => {
    const tokens = theme.tokens()
    const color = (token: ThemeTokenName) => resolveThemeColor(tokens, token)
    const alpha = (token: ThemeTokenName, opacity: number) => withAlpha(color(token), opacity)

    return {
      color,
      alpha,
      series: [
        color("chart-series-1"),
        color("chart-series-2"),
        color("chart-series-3"),
        color("chart-series-4"),
        color("chart-series-5"),
        color("chart-series-6"),
        color("chart-series-7"),
        color("chart-series-8"),
        color("chart-series-9"),
      ],
      axis: color("text-weak"),
      axisStrong: color("text-base"),
      grid: color("border-weak-base"),
      background: color("surface-raised-stronger-non-alpha"),
      foreground: color("text-strong"),
    }
  })
}

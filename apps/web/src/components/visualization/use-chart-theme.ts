import { createMemo } from "solid-js"
import {
  resolveThemeColor,
  useTheme,
  withAlpha,
  type ResolvedTheme,
  type ThemeTokenName,
} from "@ericsanchezok/synergy-ui/theme"

export function createChartTheme(tokens: ResolvedTheme) {
  const color = (token: ThemeTokenName) => resolveThemeColor(tokens, token)
  const alpha = (token: ThemeTokenName, opacity: number) => withAlpha(color(token), opacity)
  const background = color("surface-raised-stronger-non-alpha")
  const foreground = color("text-strong")
  const axis = color("text-weak")
  const axisStrong = color("text-base")
  const grid = color("border-weak-base")

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
    axis,
    axisStrong,
    grid,
    background,
    foreground,
    canvas: background,
    legend: { labels: { color: axisStrong } },
    tooltip: {
      backgroundColor: background,
      borderColor: grid,
      borderWidth: 1,
      titleColor: foreground,
      bodyColor: axisStrong,
      footerColor: axis,
    },
    point: {
      pointBackgroundColor: background,
      pointBorderColor: grid,
      pointHoverBackgroundColor: background,
      pointHoverBorderColor: color("border-hover"),
    },
    states: {
      info: color("icon-info-base"),
      success: color("icon-success-base"),
      warning: color("icon-warning-base"),
      critical: color("icon-critical-base"),
    },
  }
}

export function useChartTheme() {
  const theme = useTheme()
  return createMemo(() => createChartTheme(theme.tokens()))
}

export type ChartTheme = ReturnType<typeof createChartTheme>

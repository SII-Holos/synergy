import { createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { Line } from "solid-chartjs"
import {
  Chart as ChartJS,
  Filler,
  Tooltip,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  type ChartData,
  type ChartOptions,
  type ScriptableContext,
} from "chart.js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { useLocale } from "@/context/locale"
import { formatCompact, formatCost } from "./use-stats"
import { useChartTheme } from "../visualization/use-chart-theme"
import { S } from "./stats-i18n"

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

type Range = 7 | 14 | 30 | "all"

type DailyPoint = {
  day: string
  label: string
  cost: number
  tokens: number
}

type RangeDef = { label: string; value: Range }

function totalTokens(tokens: StatsSnapshot["timeSeries"]["days"][number]["tokens"]): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function formatTokenValue(value: number): string {
  return `${formatCompact(value)} tok`
}

function createAreaFill(ctx: ScriptableContext<"line">, top: string, bottom: string): CanvasGradient | string {
  const chart = ctx.chart
  const chartArea = chart.chartArea
  if (!chartArea) return top
  const gradient = chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
  gradient.addColorStop(0, top)
  gradient.addColorStop(1, bottom)
  return gradient
}

export function DailyTrend(props: { days: StatsSnapshot["timeSeries"]["days"] }) {
  const theme = useChartTheme()
  const { i18n, fmt } = useLocale()
  const [range, setRange] = createSignal<Range>(14)

  const ranges = createMemo<RangeDef[]>(() => [
    { label: i18n._(S.dailyRange7d.id), value: 7 },
    { label: i18n._(S.dailyRange14d.id), value: 14 },
    { label: i18n._(S.dailyRange30d.id), value: 30 },
    { label: i18n._(S.dailyRangeAll.id), value: "all" },
  ])

  const filtered = createMemo(() => {
    const selectedRange = range()
    if (selectedRange === "all") return props.days
    return props.days.slice(-selectedRange)
  })

  const points = createMemo<DailyPoint[]>(() =>
    filtered().map((day) => ({
      day: day.day,
      label: fmt.date(new Date(day.day), { month: "short", day: "numeric" }),
      cost: day.cost,
      tokens: totalTokens(day.tokens),
    })),
  )

  const peaks = createMemo(() => {
    const dailyPoints = points()
    if (dailyPoints.length === 0) return { cost: null, tokens: null }

    const highestCost = dailyPoints.reduce((peak, point) => (point.cost > peak.cost ? point : peak), dailyPoints[0])
    const highestVolume = dailyPoints.reduce(
      (peak, point) => (point.tokens > peak.tokens ? point : peak),
      dailyPoints[0],
    )

    return {
      cost: highestCost,
      tokens: highestVolume,
    }
  })

  const xTickEvery = createMemo(() => Math.max(1, Math.ceil(points().length / 6)))

  const chartData = createMemo<ChartData<"line">>(() => ({
    labels: points().map((point) => point.label),
    datasets: [
      {
        label: i18n._(S.dailyCostLegend.id),
        data: points().map((point) => point.cost),
        yAxisID: "cost",
        borderColor: theme().series[0],
        backgroundColor: (ctx) =>
          createAreaFill(ctx, theme().alpha("chart-series-1", 0.24), theme().alpha("chart-series-1", 0.03)),
        fill: true,
        tension: 0.36,
        borderWidth: 2.6,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 3,
        pointHitRadius: 18,
        pointBackgroundColor: theme().series[0],
        pointHoverBackgroundColor: theme().background,
        pointHoverBorderColor: theme().series[0],
      },
      {
        label: i18n._(S.dailyTokensLegend.id),
        data: points().map((point) => point.tokens),
        yAxisID: "tokens",
        borderColor: theme().series[1],
        backgroundColor: (ctx) =>
          createAreaFill(ctx, theme().alpha("chart-series-2", 0.22), theme().alpha("chart-series-2", 0.03)),
        fill: true,
        tension: 0.34,
        borderWidth: 2.6,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 3,
        pointHitRadius: 18,
        pointBackgroundColor: theme().series[1],
        pointHoverBackgroundColor: theme().background,
        pointHoverBorderColor: theme().series[1],
      },
    ],
  }))

  const chartOptions = createMemo<ChartOptions<"line">>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: "index",
      intersect: false,
    },
    animation: {
      duration: 720,
      easing: "easeOutQuart",
    },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        mode: "index",
        intersect: false,
        displayColors: false,
        backgroundColor: theme().background,
        borderColor: theme().grid,
        borderWidth: 1,
        padding: 12,
        titleColor: theme().foreground,
        bodyColor: theme().axisStrong,
        titleMarginBottom: 6,
        callbacks: {
          title: (items) => {
            const index = items[0]?.dataIndex ?? 0
            return points()[index]?.label ?? ""
          },
          label: (context) => {
            const value = Number(context.raw ?? 0)
            if (context.dataset.label === i18n._(S.dailyCostLegend.id))
              return i18n._(S.dailyTooltipCost.id, { value: formatCost(value) })
            return i18n._(S.dailyTooltipTokens.id, { value: formatTokenValue(value) })
          },
        },
      },
    },
    scales: {
      x: {
        grid: {
          display: false,
          drawBorder: false,
        },
        border: {
          display: false,
        },
        ticks: {
          color: theme().axisStrong,
          autoSkip: false,
          maxRotation: 0,
          minRotation: 0,
          padding: 10,
          callback: (_value, index) => {
            const dailyPoints = points()
            if (dailyPoints.length === 0) return ""
            if (index === dailyPoints.length - 1 || index % xTickEvery() === 0) return dailyPoints[index]?.label ?? ""
            return ""
          },
        },
      },
      cost: {
        position: "left",
        border: {
          display: false,
        },
        title: {
          display: true,
          text: i18n._(S.dailyCostLabel.id),
          color: theme().axis,
          padding: { bottom: 6 },
        },
        grid: {
          color: theme().grid,
          drawBorder: false,
        },
        ticks: {
          color: theme().axis,
          padding: 8,
          callback: (value) => formatCost(Number(value)),
        },
      },
      tokens: {
        position: "right",
        border: {
          display: false,
        },
        title: {
          display: true,
          text: i18n._(S.dailyTokensLabel.id),
          color: theme().axis,
          padding: { bottom: 6 },
        },
        grid: {
          drawOnChartArea: false,
          drawBorder: false,
        },
        ticks: {
          color: theme().axis,
          padding: 8,
          callback: (value) => formatCompact(Number(value)),
        },
      },
    },
  }))

  return (
    <div class="rounded-2xl bg-surface-raised-base px-4 py-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="text-14-semibold text-text-base">{i18n._(S.dailyTitle.id)}</h3>
          <p class="mt-1 text-11-regular text-text-weak">{i18n._(S.dailySubtitle.id)}</p>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-1.5">
          {ranges().map((item) => {
            const active = () => range() === item.value
            return (
              <button
                type="button"
                class={`rounded-full px-2.5 py-1 text-11-medium transition-all duration-200 ${
                  active()
                    ? "bg-surface-interactive-solid text-text-on-interactive-base shadow-sm"
                    : "bg-surface-inset-base/70 text-text-weak hover:bg-surface-inset-base hover:text-text-base"
                }`}
                onClick={() => setRange(item.value)}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      </div>

      <div class="mt-3 flex flex-wrap gap-2">
        <div class="inline-flex items-center gap-2 rounded-full bg-surface-inset-base/70 px-3 py-1.5 text-11-medium text-text-base">
          <span class="h-2.5 w-2.5 rounded-full" style={{ background: theme().series[0] }} />
          <span>{i18n._(S.dailyCostLegend.id)}</span>
        </div>
        <div class="inline-flex items-center gap-2 rounded-full bg-surface-inset-base/70 px-3 py-1.5 text-11-medium text-text-base">
          <span class="h-2.5 w-2.5 rounded-full" style={{ background: theme().series[1] }} />
          <span>{i18n._(S.dailyTokensLegend.id)}</span>
        </div>
      </div>

      <div class="mt-3 rounded-2xl bg-surface-inset-base/45 p-3">
        <div class="mb-3 flex flex-wrap gap-2">
          <Show when={peaks().cost}>
            {(peak) => (
              <div class="inline-flex min-w-[10rem] items-center gap-3 rounded-2xl border border-border-base/50 bg-surface-raised-stronger-non-alpha/70 px-3 py-2 text-text-base backdrop-blur-sm">
                <div class="h-8 w-1 rounded-full" style={{ background: theme().series[0] }} />
                <div class="min-w-0">
                  <div class="text-[10px] font-medium uppercase tracking-[0.14em] text-text-weak">
                    {i18n._(S.dailyPeakCost.id)}
                  </div>
                  <div class="mt-0.5 flex items-baseline gap-2 tabular-nums">
                    <span class="text-13-semibold text-text-base">{formatCost(peak().cost)}</span>
                    <span class="text-11-regular text-text-weak">{peak().label}</span>
                  </div>
                </div>
              </div>
            )}
          </Show>
          <Show when={peaks().tokens}>
            {(peak) => (
              <div class="inline-flex min-w-[10rem] items-center gap-3 rounded-2xl border border-border-base/50 bg-surface-raised-stronger-non-alpha/70 px-3 py-2 text-text-base backdrop-blur-sm">
                <div class="h-8 w-1 rounded-full" style={{ background: theme().series[1] }} />
                <div class="min-w-0">
                  <div class="text-[10px] font-medium uppercase tracking-[0.14em] text-text-weak">
                    {i18n._(S.dailyPeakVolume.id)}
                  </div>
                  <div class="mt-0.5 flex items-baseline gap-2 tabular-nums">
                    <span class="text-13-semibold text-text-base">{formatTokenValue(peak().tokens)}</span>
                    <span class="text-11-regular text-text-weak">{peak().label}</span>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </div>

        <Show
          when={points().length > 0}
          fallback={
            <div class="flex h-56 items-center justify-center rounded-xl border border-border-base/45 bg-surface-raised-stronger-non-alpha/65 text-12-medium text-text-weak">
              {i18n._(S.dailyEmpty.id)}
            </div>
          }
        >
          <Switch>
            <Match when={range() === 7}>
              <div class="h-56 sm:h-64">
                <Line data={chartData()} options={chartOptions()} />
              </div>
            </Match>
            <Match when={range() === 14}>
              <div class="h-56 sm:h-64">
                <Line data={chartData()} options={chartOptions()} />
              </div>
            </Match>
            <Match when={range() === 30}>
              <div class="h-56 sm:h-64">
                <Line data={chartData()} options={chartOptions()} />
              </div>
            </Match>
            <Match when={range() === "all"}>
              <div class="h-56 sm:h-64">
                <Line data={chartData()} options={chartOptions()} />
              </div>
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}

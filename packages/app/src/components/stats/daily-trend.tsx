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
import { formatCompact, formatCost } from "./use-stats"

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip)

type Range = 7 | 14 | 30 | "all"

type DailyPoint = {
  day: string
  label: string
  cost: number
  tokens: number
}

const RANGES: { label: string; value: Range }[] = [
  { label: "7d", value: 7 },
  { label: "14d", value: 14 },
  { label: "30d", value: 30 },
  { label: "All", value: "all" },
]

const COST_COLOR = "rgba(99, 102, 241, 0.96)"
const COST_FILL_TOP = "rgba(99, 102, 241, 0.26)"
const COST_FILL_BOTTOM = "rgba(99, 102, 241, 0.02)"
const TOKEN_COLOR = "rgba(16, 185, 129, 0.96)"
const TOKEN_FILL_TOP = "rgba(16, 185, 129, 0.24)"
const TOKEN_FILL_BOTTOM = "rgba(16, 185, 129, 0.02)"
const AXIS_TEXT = "rgba(120,120,135,.82)"
const AXIS_TEXT_STRONG = "rgba(146,146,162,.92)"
const GRID_COLOR = "rgba(120,120,135,.12)"

function formatDayLabel(day: string): string {
  return new Date(day).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
}

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
  const [range, setRange] = createSignal<Range>(14)

  const filtered = createMemo(() => {
    const selectedRange = range()
    if (selectedRange === "all") return props.days
    return props.days.slice(-selectedRange)
  })

  const points = createMemo<DailyPoint[]>(() =>
    filtered().map((day) => ({
      day: day.day,
      label: formatDayLabel(day.day),
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
        label: "Cost",
        data: points().map((point) => point.cost),
        yAxisID: "cost",
        borderColor: COST_COLOR,
        backgroundColor: (ctx) => createAreaFill(ctx, COST_FILL_TOP, COST_FILL_BOTTOM),
        fill: true,
        tension: 0.36,
        borderWidth: 2.6,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 3,
        pointHitRadius: 18,
        pointBackgroundColor: COST_COLOR,
        pointHoverBackgroundColor: "rgba(255,255,255,0.95)",
        pointHoverBorderColor: COST_COLOR,
      },
      {
        label: "Tokens",
        data: points().map((point) => point.tokens),
        yAxisID: "tokens",
        borderColor: TOKEN_COLOR,
        backgroundColor: (ctx) => createAreaFill(ctx, TOKEN_FILL_TOP, TOKEN_FILL_BOTTOM),
        fill: true,
        tension: 0.34,
        borderWidth: 2.6,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 3,
        pointHitRadius: 18,
        pointBackgroundColor: TOKEN_COLOR,
        pointHoverBackgroundColor: "rgba(255,255,255,0.95)",
        pointHoverBorderColor: TOKEN_COLOR,
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
        backgroundColor: "rgba(14, 16, 24, 0.94)",
        borderColor: "rgba(255,255,255,0.08)",
        borderWidth: 1,
        padding: 12,
        titleColor: "rgba(247,247,250,0.98)",
        bodyColor: "rgba(221,221,230,0.96)",
        titleMarginBottom: 6,
        callbacks: {
          title: (items) => {
            const index = items[0]?.dataIndex ?? 0
            return points()[index]?.label ?? ""
          },
          label: (context) => {
            const value = Number(context.raw ?? 0)
            if (context.dataset.label === "Cost") return `Cost: ${formatCost(value)}`
            return `Tokens: ${formatTokenValue(value)}`
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
          color: AXIS_TEXT_STRONG,
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
          text: "Cost ($)",
          color: AXIS_TEXT,
          padding: { bottom: 6 },
        },
        grid: {
          color: GRID_COLOR,
          drawBorder: false,
        },
        ticks: {
          color: AXIS_TEXT,
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
          text: "Tokens",
          color: AXIS_TEXT,
          padding: { bottom: 6 },
        },
        grid: {
          drawOnChartArea: false,
          drawBorder: false,
        },
        ticks: {
          color: AXIS_TEXT,
          padding: 8,
          callback: (value) => formatCompact(Number(value)),
        },
      },
    },
  }))

  return (
    <div class="mt-5 rounded-2xl bg-surface-raised-base px-4 py-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="text-14-semibold text-text-base">Daily Trend</h3>
          <p class="mt-1 text-11-regular text-text-weak">Cost and token volume over time</p>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-1.5">
          {RANGES.map((item) => {
            const active = () => range() === item.value
            return (
              <button
                type="button"
                class={`rounded-full px-2.5 py-1 text-11-medium transition-all duration-200 ${
                  active()
                    ? "bg-surface-interactive-base text-text-on-interactive-base shadow-sm"
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
          <span class="h-2.5 w-2.5 rounded-full" style={{ background: COST_COLOR }} />
          <span>Cost</span>
        </div>
        <div class="inline-flex items-center gap-2 rounded-full bg-surface-inset-base/70 px-3 py-1.5 text-11-medium text-text-base">
          <span class="h-2.5 w-2.5 rounded-full" style={{ background: TOKEN_COLOR }} />
          <span>Tokens</span>
        </div>
      </div>

      <div class="mt-3 rounded-2xl bg-surface-inset-base/45 p-3">
        <div class="mb-3 flex flex-wrap gap-2">
          <Show when={peaks().cost}>
            {(peak) => (
              <div class="inline-flex min-w-[10rem] items-center gap-3 rounded-2xl border border-white/8 bg-black/10 px-3 py-2 text-text-base backdrop-blur-sm">
                <div class="h-8 w-1 rounded-full" style={{ background: COST_COLOR }} />
                <div class="min-w-0">
                  <div class="text-[10px] font-medium uppercase tracking-[0.14em] text-text-weak">Highest cost</div>
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
              <div class="inline-flex min-w-[10rem] items-center gap-3 rounded-2xl border border-white/8 bg-black/10 px-3 py-2 text-text-base backdrop-blur-sm">
                <div class="h-8 w-1 rounded-full" style={{ background: TOKEN_COLOR }} />
                <div class="min-w-0">
                  <div class="text-[10px] font-medium uppercase tracking-[0.14em] text-text-weak">Highest volume</div>
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
            <div class="flex h-56 items-center justify-center rounded-xl border border-white/6 bg-black/10 text-12-medium text-text-weak">
              No daily activity yet
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

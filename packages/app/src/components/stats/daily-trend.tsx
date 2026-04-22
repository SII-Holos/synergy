import { createSignal, createMemo } from "solid-js"
import { Line } from "solid-chartjs"
import { Chart as ChartJS, Filler, Tooltip } from "chart.js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { formatCompact } from "./use-stats"

ChartJS.register(Filler, Tooltip)

type Range = 7 | 14 | 30 | "all"

const RANGES: { label: string; value: Range }[] = [
  { label: "7d", value: 7 },
  { label: "14d", value: 14 },
  { label: "30d", value: 30 },
  { label: "All", value: "all" },
]

const ENTRY_STYLE = `
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
`

function formatDay(dateStr: string): string {
  const d = new Date(dateStr)
  const month = d.toLocaleString("en-US", { month: "short" })
  return `${month} ${d.getDate()}`
}

function totalTokens(tokens: StatsSnapshot["timeSeries"]["days"][number]["tokens"]): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function DailyTrend(props: { days: StatsSnapshot["timeSeries"]["days"] }) {
  const [range, setRange] = createSignal<Range>(14)

  const filtered = createMemo(() => {
    const r = range()
    if (r === "all") return props.days
    return props.days.slice(-r)
  })

  const chartData = createMemo(() => {
    const data = filtered()
    return {
      labels: data.map((d) => formatDay(d.day)),
      datasets: [
        {
          label: "Cost",
          data: data.map((d) => d.cost),
          borderColor: "rgba(99, 102, 241, 0.8)",
          backgroundColor: (ctx: any) => {
            const chart = ctx.chart
            const { ctx: canvasCtx, chartArea } = chart
            if (!chartArea) return "rgba(99, 102, 241, 0.15)"
            const gradient = canvasCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
            gradient.addColorStop(0, "rgba(99, 102, 241, 0.15)")
            gradient.addColorStop(1, "rgba(99, 102, 241, 0)")
            return gradient
          },
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 3,
          yAxisID: "y",
        },
        {
          label: "Tokens",
          data: data.map((d) => totalTokens(d.tokens)),
          borderColor: "rgba(16, 185, 129, 0.8)",
          backgroundColor: (ctx: any) => {
            const chart = ctx.chart
            const { ctx: canvasCtx, chartArea } = chart
            if (!chartArea) return "rgba(16, 185, 129, 0.1)"
            const gradient = canvasCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
            gradient.addColorStop(0, "rgba(16, 185, 129, 0.1)")
            gradient.addColorStop(1, "rgba(16, 185, 129, 0)")
            return gradient
          },
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 3,
          yAxisID: "y1",
        },
      ],
    }
  })

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: "index" as const,
      intersect: false,
    },
    animation: {
      duration: 800,
      easing: "easeOutQuart" as const,
    },
    plugins: {
      tooltip: {
        mode: "index" as const,
        intersect: false,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: "rgba(255,255,255,0.3)" },
      },
      y: {
        position: "left" as const,
        grid: { color: "rgba(128,128,128,0.08)" },
        ticks: {
          callback: (v: any) => "$" + formatCompact(v as number),
        },
      },
      y1: {
        position: "right" as const,
        grid: { display: false },
        ticks: {
          callback: (v: any) => formatCompact(v as number),
        },
      },
    },
  }

  return (
    <>
      <style>{ENTRY_STYLE}</style>
      <div
        class="bg-surface-raised-base rounded-xl p-3"
        style={{ animation: "fadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) 180ms both" }}
      >
        <div class="flex items-center justify-between mb-2">
          <span class="text-12-semibold text-text-weak">📈 Daily Trend</span>
          <div class="flex gap-1">
            {RANGES.map((r) => (
              <button
                class={`text-10-medium px-2 py-0.5 rounded-md transition-colors ${
                  range() === r.value
                    ? "bg-surface-interactive-base text-text-on-interactive-base"
                    : "bg-surface-inset-base/60 text-text-weak"
                }`}
                onClick={() => setRange(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div class="h-44">
          <Line data={chartData()} options={chartOptions} />
        </div>
      </div>
    </>
  )
}

import { For, Show, createMemo } from "solid-js"
import { Radar, Bar } from "solid-chartjs"
import {
  Chart as ChartJS,
  RadialLinearScale,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
} from "chart.js"
import { useChartTheme } from "../../visualization/use-chart-theme"

ChartJS.register(RadialLinearScale, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler, Tooltip)

const DIMENSION_LABELS: Record<string, string> = {
  outcome: "Outcome",
  intent: "Intent",
  execution: "Execution",
  orchestration: "Orchestration",
  expression: "Expression",
}

function formatR(v: number) {
  return v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)
}

type DimStats = {
  dimension: string
  avg: number
  std: number
  distribution: Array<{ value: number; count: number }>
}

export function RewardRadar(props: { dimensions: DimStats[] }) {
  const theme = useChartTheme()
  const dims = () => props.dimensions

  // Radar chart: uses avg per dimension
  const radarData = createMemo(() => {
    const d = dims()
    if (d.length === 0) return null
    return {
      labels: d.map((dim) => DIMENSION_LABELS[dim.dimension] ?? dim.dimension),
      datasets: [
        {
          label: "Average",
          data: d.map((dim) => dim.avg),
          borderColor: theme().series[0],
          backgroundColor: theme().alpha("chart-series-1", 0.12),
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: theme().series[0],
          pointBorderColor: theme().background,
          pointBorderWidth: 1.5,
          fill: true,
        },
      ],
    }
  })

  const radarOptions = createMemo(() => ({
    responsive: true,
    maintainAspectRatio: true,
    scales: {
      r: {
        min: -1,
        max: 1,
        ticks: {
          stepSize: 0.5,
          font: { size: 9 },
          color: theme().axis,
          backdropColor: "transparent",
          callback: (v: number | string) => {
            const n = typeof v === "string" ? parseFloat(v) : v
            return n === 0 ? "0" : n > 0 ? `+${n}` : `${n}`
          },
        },
        grid: { color: theme().grid },
        angleLines: { color: theme().grid },
        pointLabels: {
          font: { size: 12, weight: "bold" as const },
          color: theme().axisStrong,
          padding: 14,
        },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { raw: number }) => `avg: ${formatR(ctx.raw as number)}`,
        },
      },
    },
    animation: { duration: 600, easing: "easeOutQuart" as const },
  }))

  // Stacked bar chart: shows distribution of -1/0/1 per dimension
  const barData = createMemo(() => {
    const d = dims()
    if (d.length === 0) return null

    const labels = d.map((dim) => DIMENSION_LABELS[dim.dimension] ?? dim.dimension)

    // For each dimension, get counts for -1, 0, 1
    const getCount = (dim: DimStats, val: number) => dim.distribution.find((v) => v.value === val)?.count ?? 0

    const totals = d.map((dim) => dim.distribution.reduce((s, v) => s + v.count, 0))

    return {
      labels,
      datasets: [
        {
          label: "Positive (+1)",
          data: d.map((dim, i) => {
            const t = totals[i]!
            return t > 0 ? (getCount(dim, 1) / t) * 100 : 0
          }),
          backgroundColor: theme().alpha("text-on-success-base", 0.72),
          borderRadius: 2,
        },
        {
          label: "Neutral (0)",
          data: d.map((dim, i) => {
            const t = totals[i]!
            return t > 0 ? (getCount(dim, 0) / t) * 100 : 0
          }),
          backgroundColor: theme().alpha("text-weak", 0.45),
          borderRadius: 2,
        },
        {
          label: "Negative (−1)",
          data: d.map((dim, i) => {
            const t = totals[i]!
            return t > 0 ? (getCount(dim, -1) / t) * 100 : 0
          }),
          backgroundColor: theme().alpha("text-on-critical-base", 0.65),
          borderRadius: 2,
        },
      ],
    }
  })

  const barOptions = createMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: "y" as const,
    scales: {
      x: {
        stacked: true,
        max: 100,
        grid: { color: theme().grid },
        ticks: {
          font: { size: 9 },
          color: theme().axis,
          callback: (v: number | string) => `${v}%`,
        },
      },
      y: {
        stacked: true,
        grid: { display: false },
        ticks: {
          font: { size: 10, weight: "bold" as const },
          color: theme().axisStrong,
        },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { dataset: { label?: string }; raw: number }) =>
            `${ctx.dataset.label}: ${(ctx.raw as number).toFixed(1)}%`,
        },
      },
    },
    animation: { duration: 500, easing: "easeOutQuart" as const },
  }))

  return (
    <div class="library-chart-surface mt-4">
      <div class="pb-2">
        <h3 class="text-13-medium text-text-strong">Reward dimensions</h3>
      </div>

      <Show when={dims().length > 0} fallback={<div class="library-empty-row">No evaluated experiences yet</div>}>
        <div class="flex gap-4">
          {/* Radar chart — left */}
          <div class="shrink-0" style={{ width: "280px" }}>
            <Show keyed when={radarData()}>
              {(data) => <Radar data={data} options={radarOptions()} />}
            </Show>
          </div>

          {/* Stats column — right */}
          <div class="flex-1 min-w-0 flex flex-col gap-1.5 justify-center">
            <For each={dims()}>
              {(dim) => {
                const label = DIMENSION_LABELS[dim.dimension] ?? dim.dimension
                const total = dim.distribution.reduce((s, v) => s + v.count, 0)
                const pos = dim.distribution.find((v) => v.value === 1)?.count ?? 0
                const neg = dim.distribution.find((v) => v.value === -1)?.count ?? 0
                const neu = dim.distribution.find((v) => v.value === 0)?.count ?? 0
                return (
                  <div class="flex items-center gap-3 rounded-lg bg-surface-inset-base px-2.5 py-1.5 ring-1 ring-inset ring-border-base/25">
                    <span class="shrink-0 w-20 text-10-medium text-text-base truncate">{label}</span>
                    <span class="shrink-0 w-12 text-11-semibold text-text-strong tabular-nums text-right">
                      {formatR(dim.avg)}
                    </span>
                    <div class="flex-1 flex items-center gap-1 text-9-regular tabular-nums text-text-weak">
                      <span class="text-text-on-success-base">
                        {total > 0 ? `${((pos / total) * 100).toFixed(0)}%` : "—"}
                      </span>
                      <span class="text-text-weaker">/</span>
                      <span>{total > 0 ? `${((neu / total) * 100).toFixed(0)}%` : "—"}</span>
                      <span class="text-text-weaker">/</span>
                      <span class="text-text-on-critical-base">
                        {total > 0 ? `${((neg / total) * 100).toFixed(0)}%` : "—"}
                      </span>
                    </div>
                    <span class="shrink-0 text-9-regular text-text-weaker tabular-nums">σ {dim.std.toFixed(2)}</span>
                  </div>
                )
              }}
            </For>
            {/* Legend for percentages */}
            <div class="flex items-center gap-3 px-2.5 pt-1 text-8-regular text-text-weaker">
              <span class="text-text-on-success-base/70">■ +1</span>
              <span>■ 0</span>
              <span class="text-text-on-critical-base/70">■ −1</span>
            </div>
          </div>
        </div>

        {/* Stacked bar chart below */}
        <div class="library-chart-inner mt-3">
          <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak mb-2">
            Reward Distribution by Dimension
          </div>
          <div class="h-36">
            <Show keyed when={barData()}>
              {(data) => <Bar data={data} options={barOptions()} />}
            </Show>
          </div>
          {/* Legend */}
          <div class="flex items-center gap-4 mt-2 text-9-regular text-text-weaker">
            <div class="flex items-center gap-1.5">
              <span class="inline-block h-2.5 w-2.5 rounded-sm bg-icon-success-base" />
              <span>Positive (+1)</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="inline-block h-2.5 w-2.5 rounded-sm bg-icon-weak-base" />
              <span>Neutral (0)</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="inline-block h-2.5 w-2.5 rounded-sm bg-icon-critical-base" />
              <span>Negative (−1)</span>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

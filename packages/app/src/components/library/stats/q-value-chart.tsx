import { Show, createMemo } from "solid-js"
import { Bar, Line } from "solid-chartjs"
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
} from "chart.js"
import { useChartTheme } from "../../visualization/use-chart-theme"

ChartJS.register(CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler, Tooltip)

function formatQ(v: number) {
  return v >= 0 ? `+${v.toFixed(3)}` : v.toFixed(3)
}

export function QValueChart(props: {
  distribution: {
    histogram: Array<{ bin: string; count: number }>
    trend: Array<{ period: string; medianQ: number; count: number }>
    avgCompositeQ: number
    medianCompositeQ: number
    stdCompositeQ: number
  }
  rl: {
    avgVisits: number
    medianVisits: number
    neverRetrieved: number
    frequentlyRetrieved: number
  }
}) {
  const theme = useChartTheme()
  const dist = () => props.distribution
  const total = () => dist().histogram.reduce((sum, b) => sum + b.count, 0)

  const histData = createMemo(() => {
    const bins = dist().histogram
    return {
      labels: bins.map((b) => b.bin),
      datasets: [
        {
          data: bins.map((b) => b.count),
          backgroundColor: bins.map((b) => {
            const center = parseFloat(b.bin)
            if (center < -0.3) return theme().alpha("text-on-critical-base", 0.72)
            if (center < 0) return theme().alpha("text-on-warning-base", 0.62)
            if (center < 0.3) return theme().alpha("text-weak", 0.38)
            return theme().alpha("text-on-success-base", 0.72)
          }),
          borderRadius: 2,
          barPercentage: 1.0,
          categoryPercentage: 0.92,
        },
      ],
    }
  })

  const histOptions = createMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          font: { size: 8 },
          color: theme().axis,
          maxRotation: 0,
          callback: function (this: any, _val: any, index: number) {
            return index % 5 === 0 ? this.getLabelForValue(index) : ""
          },
        },
      },
      y: {
        grid: { color: theme().grid },
        ticks: { font: { size: 8 }, color: theme().axis },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items: { label: string }[]) => {
            const label = items[0]?.label ?? ""
            return `Q range: ${label}`
          },
          label: (ctx: { raw: number }) => `${ctx.raw} experiences`,
        },
      },
    },
    animation: { duration: 500, easing: "easeOutQuart" as const },
  }))

  const trendData = createMemo(() => ({
    labels: dist().trend.map((t) => t.period),
    datasets: [
      {
        data: dist().trend.map((t) => t.medianQ),
        borderColor: theme().series[0],
        backgroundColor: theme().alpha("chart-series-1", 0.08),
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: theme().series[0],
        borderWidth: 2,
      },
    ],
  }))

  const trendOptions = createMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 8 }, color: theme().axis },
      },
      y: {
        min: -1,
        max: 1,
        grid: { color: theme().grid },
        ticks: {
          font: { size: 8 },
          color: theme().axis,
          stepSize: 0.5,
          callback: (v: number | string) => {
            const n = typeof v === "string" ? parseFloat(v) : v
            return n === 0 ? "0" : n > 0 ? `+${n}` : `${n}`
          },
        },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { dataIndex: number }) => {
            const point = dist().trend[ctx.dataIndex]
            if (!point) return ""
            return `median Q: ${formatQ(point.medianQ)} (${point.count} exps)`
          },
        },
      },
    },
    animation: { duration: 500, easing: "easeOutQuart" as const },
  }))

  const hasData = () => total() > 0

  return (
    <div class="library-chart-surface mt-4">
      <div class="pb-2">
        <h3 class="text-13-medium text-text-strong">Q‑value distribution</h3>
      </div>

      <Show when={hasData()} fallback={<div class="library-empty-row">No evaluated experiences yet</div>}>
        {/* Summary row */}
        <div class="mb-3 grid grid-cols-5 gap-2">
          <div class="rounded-xl bg-surface-inset-base px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">Avg Q</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{formatQ(dist().avgCompositeQ)}</div>
          </div>
          <div class="rounded-xl bg-surface-inset-base px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">Median</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{formatQ(dist().medianCompositeQ)}</div>
          </div>
          <div class="rounded-xl bg-surface-inset-base px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">σ Q</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{dist().stdCompositeQ.toFixed(3)}</div>
          </div>
          <div class="rounded-xl bg-surface-inset-base px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">Unused</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{props.rl.neverRetrieved}</div>
          </div>
          <div class="rounded-xl bg-surface-inset-base px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">Active</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{props.rl.frequentlyRetrieved}</div>
          </div>
        </div>

        {/* Histogram + trend side-by-side */}
        <div class="grid grid-cols-1 gap-2.5">
          <div class="library-chart-inner">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak mb-1.5">
              Composite Q Histogram
            </div>
            <div class="h-32">
              <Bar data={histData()} options={histOptions()} />
            </div>
          </div>

          <Show when={dist().trend.length >= 2}>
            <div class="library-chart-inner">
              <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak mb-1.5">
                Median Q · Weekly Trend
              </div>
              <div class="h-28">
                <Line data={trendData()} options={trendOptions()} />
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

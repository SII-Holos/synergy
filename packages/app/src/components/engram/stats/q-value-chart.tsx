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
            if (center < -0.3) return "rgba(196, 92, 68, 0.72)"
            if (center < 0) return "rgba(196, 132, 36, 0.62)"
            if (center < 0.3) return "rgba(148, 148, 148, 0.38)"
            return "rgba(39, 143, 116, 0.72)"
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
          color: "rgba(128,128,128,0.55)",
          maxRotation: 0,
          callback: function (this: any, _val: any, index: number) {
            return index % 5 === 0 ? this.getLabelForValue(index) : ""
          },
        },
      },
      y: {
        grid: { color: "rgba(128,128,128,0.08)" },
        ticks: { font: { size: 8 }, color: "rgba(128,128,128,0.55)" },
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
        borderColor: "rgba(56, 88, 182, 0.85)",
        backgroundColor: "rgba(56, 88, 182, 0.08)",
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: "rgba(56, 88, 182, 0.85)",
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
        ticks: { font: { size: 8 }, color: "rgba(128,128,128,0.55)" },
      },
      y: {
        min: -1,
        max: 1,
        grid: { color: "rgba(128,128,128,0.08)" },
        ticks: {
          font: { size: 8 },
          color: "rgba(128,128,128,0.55)",
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
    <div class="mt-4 rounded-[1.25rem] bg-surface-raised-base/95 p-4 shadow-[inset_0_1px_0_rgba(214,204,190,0.06),inset_0_-1px_0_rgba(24,28,38,0.04)]">
      <div class="pb-2">
        <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Quality</div>
        <h3 class="mt-1 text-15-semibold text-text-strong tracking-tight">Q-Value Distribution</h3>
      </div>

      <Show
        when={hasData()}
        fallback={
          <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-5 text-11-regular text-text-weak">
            No evaluated experiences yet
          </div>
        }
      >
        {/* Summary row */}
        <div class="mb-3 grid grid-cols-5 gap-2">
          <div class="rounded-xl bg-surface-inset-base/45 px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">Avg Q</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{formatQ(dist().avgCompositeQ)}</div>
          </div>
          <div class="rounded-xl bg-surface-inset-base/45 px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">Median</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{formatQ(dist().medianCompositeQ)}</div>
          </div>
          <div class="rounded-xl bg-surface-inset-base/45 px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">σ Q</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{dist().stdCompositeQ.toFixed(3)}</div>
          </div>
          <div class="rounded-xl bg-surface-inset-base/45 px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">Unused</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{props.rl.neverRetrieved}</div>
          </div>
          <div class="rounded-xl bg-surface-inset-base/45 px-2.5 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak">Active</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{props.rl.frequentlyRetrieved}</div>
          </div>
        </div>

        {/* Histogram + trend side-by-side */}
        <div class="grid grid-cols-1 gap-2.5">
          <div class="rounded-xl bg-surface-inset-base/45 px-3 py-2.5 ring-1 ring-inset ring-border-base/45">
            <div class="text-[8px] font-medium uppercase tracking-[0.12em] text-text-weak mb-1.5">
              Composite Q Histogram
            </div>
            <div class="h-32">
              <Bar data={histData()} options={histOptions()} />
            </div>
          </div>

          <Show when={dist().trend.length >= 2}>
            <div class="rounded-xl bg-surface-inset-base/45 px-3 py-2.5 ring-1 ring-inset ring-border-base/45">
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

import { Doughnut } from "solid-chartjs"
import { Chart as ChartJS, ArcElement, Tooltip, DoughnutController } from "chart.js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { formatCompact } from "./use-stats"

ChartJS.register(ArcElement, Tooltip, DoughnutController)

const SEGMENTS = [
  { key: "input" as const, label: "Input", color: "rgba(99, 102, 241, 0.85)" },
  { key: "output" as const, label: "Output", color: "rgba(16, 185, 129, 0.85)" },
  { key: "reasoning" as const, label: "Reasoning", color: "rgba(245, 158, 11, 0.85)" },
  { key: "cacheRead" as const, label: "Cache Read", color: "rgba(139, 92, 246, 0.85)" },
  { key: "cacheWrite" as const, label: "Cache Write", color: "rgba(236, 72, 153, 0.85)" },
]

const ANIMATION_STYLE = `
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
`

export function TokenRing(props: { tokens: StatsSnapshot["tokenCost"]["tokens"]; cacheHitRate: number }) {
  const values = () => [
    props.tokens.input,
    props.tokens.output,
    props.tokens.reasoning,
    props.tokens.cache.read,
    props.tokens.cache.write,
  ]

  const total = () => values().reduce((a, b) => a + b, 0)

  const chartData = () => ({
    labels: SEGMENTS.map((s) => s.label),
    datasets: [
      {
        data: values(),
        backgroundColor: SEGMENTS.map((s) => s.color),
        borderWidth: 2,
        borderColor: "rgba(0,0,0,0.1)",
        spacing: 3,
      },
    ],
  })

  const chartOptions = () => ({
    responsive: true,
    maintainAspectRatio: true,
    cutout: "68%" as const,
    animation: {
      animateRotate: true,
      duration: 1000,
      easing: "easeOutQuart" as const,
    },
    plugins: {
      tooltip: {
        callbacks: {
          label: (ctx: { label?: string; raw: number }) => {
            const pct = total() > 0 ? ((ctx.raw / total()) * 100).toFixed(1) : "0.0"
            return `${ctx.label}: ${formatCompact(ctx.raw)} (${pct}%)`
          },
        },
      },
    },
  })

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <div
        class="bg-surface-raised-base rounded-xl p-4"
        style={{ animation: "fadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
      >
        <div class="relative h-48 w-48 mx-auto">
          <Doughnut data={chartData()} options={chartOptions()} />
          <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span class="text-24-semibold text-text-strong tabular-nums">{Math.round(props.cacheHitRate * 100)}%</span>
            <span class="text-10-medium text-text-weak">cache hit</span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-1 mt-3">
          {SEGMENTS.map((seg, i) => (
            <div class="flex items-center gap-1.5">
              <span
                class="shrink-0 rounded-full"
                style={{
                  width: "8px",
                  height: "8px",
                  "background-color": seg.color,
                }}
              />
              <span class="text-11-regular text-text-weak">{seg.label}</span>
              <span class="text-11-medium text-text-base tabular-nums ml-auto">{formatCompact(values()[i])}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

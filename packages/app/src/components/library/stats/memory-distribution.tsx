import { For, Show, createMemo } from "solid-js"
import { Doughnut } from "solid-chartjs"
import { Chart as ChartJS, ArcElement, Tooltip, DoughnutController } from "chart.js"
import { categoryLabels } from "../shared"
import { useChartTheme } from "../../visualization/use-chart-theme"

ChartJS.register(ArcElement, Tooltip, DoughnutController)

const CATEGORY_ORDER = [
  "user",
  "self",
  "relationship",
  "interaction",
  "workflow",
  "coding",
  "writing",
  "asset",
  "insight",
  "knowledge",
  "personal",
] as const

const RECALL_MODE_STYLES: Record<string, { bg: string; label: string }> = {
  always: { bg: "bg-surface-warning-weak text-text-on-warning-base ring-border-warning-base/24", label: "Always" },
  contextual: {
    bg: "bg-surface-success-weak text-text-on-success-base ring-border-success-base/24",
    label: "Contextual",
  },
  search_only: { bg: "bg-surface-weak text-text-weak ring-border-weak-base/24", label: "Search-only" },
}

export function MemoryDistribution(props: {
  distribution: {
    byCategory: Array<{ category: string; count: number }>
    byRecallMode: Array<{ recallMode: string; count: number }>
  }
  totalMemories: number
}) {
  const theme = useChartTheme()
  const categories = () => props.distribution.byCategory
  const recallModes = () => props.distribution.byRecallMode
  const categoryColors = createMemo(() => {
    const series = theme().series
    return Object.fromEntries(CATEGORY_ORDER.map((category, index) => [category, series[index % series.length]]))
  })
  const categoryColor = (category: string) => categoryColors()[category] ?? theme().axis

  const chartData = createMemo(() => ({
    labels: categories().map((c) => categoryLabels[c.category as keyof typeof categoryLabels] ?? c.category),
    datasets: [
      {
        data: categories().map((c) => c.count),
        backgroundColor: categories().map((category) => categoryColor(category.category)),
        borderWidth: 0,
        hoverOffset: 4,
      },
    ],
  }))

  const chartOptions = createMemo(() => ({
    responsive: true,
    maintainAspectRatio: true,
    cutout: "58%" as const,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { label?: string; raw: number }) => {
            const pct = props.totalMemories > 0 ? (((ctx.raw as number) / props.totalMemories) * 100).toFixed(0) : "0"
            return `${ctx.label}: ${ctx.raw} (${pct}%)`
          },
        },
      },
    },
    animation: { duration: 600, easing: "easeOutQuart" as const },
  }))

  return (
    <div class="library-chart-surface mt-4">
      <div class="pb-2">
        <h3 class="text-13-medium text-text-strong">Memory categories</h3>
      </div>

      <Show when={props.totalMemories > 0} fallback={<div class="library-empty-row">No memories yet</div>}>
        <div class="flex gap-4">
          {/* Doughnut */}
          <div class="shrink-0 w-32 h-32 flex items-center justify-center">
            <Doughnut data={chartData()} options={chartOptions()} />
          </div>

          {/* Categories + recall modes */}
          <div class="flex-1 min-w-0 flex flex-col gap-2.5">
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={categories()}>
                {(item) => {
                  const pct = () => (props.totalMemories > 0 ? (item.count / props.totalMemories) * 100 : 0)
                  const label = categoryLabels[item.category as keyof typeof categoryLabels] ?? item.category
                  return (
                    <div class="inline-flex items-center gap-1.5 py-0.5">
                      <span
                        class="inline-block h-2 w-2 rounded-full shrink-0"
                        style={{ background: categoryColor(item.category) }}
                      />
                      <span class="text-10-medium text-text-base">{label}</span>
                      <span class="text-10-regular text-text-weak tabular-nums">{item.count}</span>
                      <span class="text-9-regular text-text-weaker tabular-nums">({pct().toFixed(0)}%)</span>
                    </div>
                  )
                }}
              </For>
            </div>
            <div class="flex flex-wrap gap-1.5 pt-1">
              <For each={recallModes()}>
                {(item) => {
                  const style = RECALL_MODE_STYLES[item.recallMode] ?? RECALL_MODE_STYLES.search_only!
                  return (
                    <div
                      class={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-10-medium ring-1 ring-inset ${style.bg}`}
                    >
                      <span class="font-semibold tabular-nums">{item.count}</span>
                      <span>{style.label}</span>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

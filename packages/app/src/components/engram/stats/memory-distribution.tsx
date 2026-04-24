import { For, Show, createMemo } from "solid-js"
import { Doughnut } from "solid-chartjs"
import { Chart as ChartJS, ArcElement, Tooltip, DoughnutController } from "chart.js"

ChartJS.register(ArcElement, Tooltip, DoughnutController)

const CATEGORY_COLORS: Record<string, string> = {
  user: "rgba(139, 92, 246, 0.82)",
  self: "rgba(56, 88, 182, 0.82)",
  relationship: "rgba(196, 92, 68, 0.82)",
  interaction: "rgba(196, 132, 36, 0.82)",
  workflow: "rgba(39, 143, 116, 0.82)",
  coding: "rgba(34, 211, 238, 0.82)",
  writing: "rgba(236, 72, 153, 0.82)",
  asset: "rgba(45, 212, 191, 0.82)",
  insight: "rgba(249, 115, 22, 0.82)",
  knowledge: "rgba(59, 130, 246, 0.82)",
  personal: "rgba(192, 132, 252, 0.82)",
  general: "rgba(128, 128, 128, 0.82)",
}

const CATEGORY_LABELS: Record<string, string> = {
  user: "User",
  self: "Self",
  relationship: "Relationship",
  interaction: "Interaction",
  workflow: "Workflow",
  coding: "Coding",
  writing: "Writing",
  asset: "Asset",
  insight: "Insight",
  knowledge: "Knowledge",
  personal: "Personal",
  general: "General",
}

const RECALL_MODE_STYLES: Record<string, { bg: string; label: string }> = {
  always: { bg: "bg-amber-500/14 text-amber-700 dark:text-amber-300 ring-amber-400/24", label: "Always" },
  contextual: {
    bg: "bg-emerald-500/14 text-emerald-700 dark:text-emerald-300 ring-emerald-400/24",
    label: "Contextual",
  },
  search_only: { bg: "bg-slate-500/14 text-slate-700 dark:text-slate-300 ring-slate-400/24", label: "Search-only" },
}

export function MemoryDistribution(props: {
  distribution: {
    byCategory: Array<{ category: string; count: number }>
    byRecallMode: Array<{ recallMode: string; count: number }>
  }
  totalMemories: number
}) {
  const categories = () => props.distribution.byCategory
  const recallModes = () => props.distribution.byRecallMode

  const chartData = createMemo(() => ({
    labels: categories().map((c) => CATEGORY_LABELS[c.category] ?? c.category),
    datasets: [
      {
        data: categories().map((c) => c.count),
        backgroundColor: categories().map((c) => CATEGORY_COLORS[c.category] ?? CATEGORY_COLORS.general!),
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
    <div class="mt-4 rounded-[1.25rem] bg-surface-raised-base/95 p-4 shadow-[inset_0_1px_0_rgba(214,204,190,0.06),inset_0_-1px_0_rgba(24,28,38,0.04)]">
      <div class="pb-2">
        <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Distribution</div>
        <h3 class="mt-1 text-15-semibold text-text-strong tracking-tight">Memory Categories</h3>
      </div>

      <Show
        when={props.totalMemories > 0}
        fallback={
          <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-5 text-11-regular text-text-weak">
            No memories yet
          </div>
        }
      >
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
                  const label = CATEGORY_LABELS[item.category] ?? item.category
                  return (
                    <div class="inline-flex items-center gap-1.5 py-0.5">
                      <span
                        class="inline-block h-2 w-2 rounded-full shrink-0"
                        style={{ background: CATEGORY_COLORS[item.category] ?? CATEGORY_COLORS.general }}
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

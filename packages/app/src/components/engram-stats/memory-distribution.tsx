import { For, Show } from "solid-js"

const CATEGORY_COLORS: Record<string, string> = {
  user: "bg-violet-500/18 text-violet-700 dark:text-violet-300",
  self: "bg-indigo-500/18 text-indigo-700 dark:text-indigo-300",
  relationship: "bg-rose-500/18 text-rose-700 dark:text-rose-300",
  interaction: "bg-amber-500/18 text-amber-700 dark:text-amber-300",
  workflow: "bg-emerald-500/18 text-emerald-700 dark:text-emerald-300",
  coding: "bg-cyan-500/18 text-cyan-700 dark:text-cyan-300",
  writing: "bg-pink-500/18 text-pink-700 dark:text-pink-300",
  asset: "bg-teal-500/18 text-teal-700 dark:text-teal-300",
  insight: "bg-orange-500/18 text-orange-700 dark:text-orange-300",
  knowledge: "bg-blue-500/18 text-blue-700 dark:text-blue-300",
  personal: "bg-fuchsia-500/18 text-fuchsia-700 dark:text-fuchsia-300",
  general: "bg-slate-500/18 text-slate-700 dark:text-slate-300",
}

const RECALL_MODE_STYLES: Record<string, { bg: string; label: string; desc: string }> = {
  always: {
    bg: "bg-amber-500/14 text-amber-700 dark:text-amber-300 ring-amber-400/24",
    label: "Always",
    desc: "Injected every session",
  },
  contextual: {
    bg: "bg-emerald-500/14 text-emerald-700 dark:text-emerald-300 ring-emerald-400/24",
    label: "Contextual",
    desc: "Retrieved when relevant",
  },
  search_only: {
    bg: "bg-slate-500/14 text-slate-700 dark:text-slate-300 ring-slate-400/24",
    label: "Search-only",
    desc: "Only via explicit search",
  },
}

export function MemoryDistribution(props: {
  distribution: {
    byCategory: Array<{ category: string; count: number }>
    byRecallMode: Array<{ recallMode: string; count: number }>
    categoryRecallMatrix: Record<string, number>
  }
  totalMemories: number
}) {
  const categories = () => props.distribution.byCategory
  const recallModes = () => props.distribution.byRecallMode

  return (
    <div class="mt-5 rounded-[1.25rem] bg-surface-raised-base/95 p-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.06),inset_0_-1px_0_rgba(24,28,38,0.04)]">
      <div class="px-1 pb-3">
        <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Distribution</div>
        <h3 class="mt-1 text-15-semibold text-text-strong tracking-tight">Memory Categories</h3>
        <p class="mt-1 text-10-regular text-text-weak">
          How knowledge is distributed across categories and recall modes
        </p>
      </div>

      <Show
        when={props.totalMemories > 0}
        fallback={
          <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-5 text-11-regular text-text-weak">
            No memories yet
          </div>
        }
      >
        {/* Category bars */}
        <div class="flex flex-col gap-2">
          <For each={categories()}>
            {(item) => {
              const pct = () => (props.totalMemories > 0 ? (item.count / props.totalMemories) * 100 : 0)
              const colorClass = () => CATEGORY_COLORS[item.category] ?? CATEGORY_COLORS.general!
              return (
                <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-2.5 ring-1 ring-inset ring-border-base/45">
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2">
                      <span
                        class={`inline-flex rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.1em] ${colorClass()}`}
                      >
                        {item.category}
                      </span>
                    </div>
                    <div class="flex items-baseline gap-2 tabular-nums">
                      <span class="text-12-semibold text-text-strong">{item.count}</span>
                      <span class="text-10-regular text-text-weak">{pct().toFixed(0)}%</span>
                    </div>
                  </div>
                  <div class="mt-2 h-1.5 rounded-full bg-surface-raised-stronger-non-alpha/50">
                    <div
                      class="h-full rounded-full bg-[linear-gradient(90deg,rgba(62,122,98,0.82),rgba(136,198,170,0.62))] transition-all duration-300"
                      style={{ width: `${pct()}%` }}
                    />
                  </div>
                </div>
              )
            }}
          </For>
        </div>

        {/* Recall mode badges */}
        <div class="mt-3 flex flex-wrap gap-2">
          <For each={recallModes()}>
            {(item) => {
              const style = RECALL_MODE_STYLES[item.recallMode] ?? RECALL_MODE_STYLES.search_only!
              return (
                <div
                  class={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-10-medium ring-1 ring-inset ${style.bg}`}
                >
                  <span class="font-semibold">{item.count}</span>
                  <span>{style.label}</span>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

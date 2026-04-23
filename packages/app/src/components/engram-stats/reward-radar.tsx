import { For, Show } from "solid-js"

const DIMENSION_COLORS = [
  "rgba(56, 88, 182, 0.96)", // outcome — indigo
  "rgba(39, 143, 116, 0.96)", // intent — emerald
  "rgba(196, 132, 36, 0.96)", // execution — amber
  "rgba(163, 92, 68, 0.96)", // orchestration — rose
  "rgba(139, 92, 246, 0.96)", // expression — violet
]

const DIMENSION_LABELS: Record<string, string> = {
  outcome: "Outcome",
  intent: "Intent",
  execution: "Execution",
  orchestration: "Orchestration",
  expression: "Expression",
}

export function RewardRadar(props: {
  dimensions: Array<{ dimension: string; avg: number; median: number; p90: number }>
}) {
  const dimensions = () => props.dimensions

  return (
    <div class="mt-5 rounded-[1.25rem] bg-surface-raised-base/95 p-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.06),inset_0_-1px_0_rgba(24,28,38,0.04)]">
      <div class="px-1 pb-3">
        <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Learning</div>
        <h3 class="mt-1 text-15-semibold text-text-strong tracking-tight">Reward Dimensions</h3>
        <p class="mt-1 text-10-regular text-text-weak">Average reward scores across five quality dimensions</p>
      </div>

      <Show
        when={dimensions().length > 0}
        fallback={
          <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-5 text-11-regular text-text-weak">
            No evaluated experiences yet
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <For each={dimensions()}>
            {(dim, index) => {
              const color = DIMENSION_COLORS[index() % DIMENSION_COLORS.length]!
              const label = DIMENSION_LABELS[dim.dimension] ?? dim.dimension
              // Reward range is -1 to 1, shift to 0-100 for display
              const pct = () => Math.max(0, Math.min(100, ((dim.avg + 1) / 2) * 100))
              const avgDisplay = () => (dim.avg >= 0 ? `+${dim.avg.toFixed(2)}` : dim.avg.toFixed(2))

              return (
                <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-2.5 ring-1 ring-inset ring-border-base/45">
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2">
                      <span class="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />
                      <span class="text-11-medium text-text-strong">{label}</span>
                    </div>
                    <div class="flex items-baseline gap-3 tabular-nums">
                      <span class="text-12-semibold text-text-strong">{avgDisplay()}</span>
                      <span class="text-10-regular text-text-weak">
                        p90 {dim.p90 >= 0 ? `+${dim.p90.toFixed(2)}` : dim.p90.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <div class="mt-2 h-1.5 rounded-full bg-surface-raised-stronger-non-alpha/50">
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      style={{ width: `${pct()}%`, background: color }}
                    />
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

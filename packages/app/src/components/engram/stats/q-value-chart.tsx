import { Show } from "solid-js"

const BUCKET_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  negative: { bg: "bg-rose-500/16", text: "text-rose-700 dark:text-rose-300", label: "Negative" },
  low: { bg: "bg-amber-500/14", text: "text-amber-700 dark:text-amber-300", label: "Low" },
  neutral: { bg: "bg-slate-500/14", text: "text-slate-700 dark:text-slate-300", label: "Neutral" },
  medium: { bg: "bg-emerald-500/14", text: "text-emerald-700 dark:text-emerald-300", label: "Medium" },
  high: { bg: "bg-teal-500/16", text: "text-teal-700 dark:text-teal-300", label: "High" },
}

const BUCKET_ORDER = ["negative", "low", "neutral", "medium", "high"] as const

export function QValueChart(props: {
  distribution: {
    negative: number
    low: number
    neutral: number
    medium: number
    high: number
    avgCompositeQ: number
    medianCompositeQ: number
  }
  rl: {
    avgVisits: number
    medianVisits: number
    neverRetrieved: number
    frequentlyRetrieved: number
  }
}) {
  const dist = () => props.distribution
  const total = () => dist().negative + dist().low + dist().neutral + dist().medium + dist().high

  return (
    <div class="mt-5 rounded-[1.25rem] bg-surface-raised-base/95 p-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.06),inset_0_-1px_0_rgba(24,28,38,0.04)]">
      <div class="px-1 pb-3">
        <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Quality</div>
        <h3 class="mt-1 text-15-semibold text-text-strong tracking-tight">Q-Value Distribution</h3>
        <p class="mt-1 text-10-regular text-text-weak">Learned quality scores across evaluated experiences</p>
      </div>

      <Show
        when={total() > 0}
        fallback={
          <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-5 text-11-regular text-text-weak">
            No evaluated experiences yet
          </div>
        }
      >
        {/* Summary stats */}
        <div class="mb-3 grid grid-cols-3 gap-2">
          <div class="rounded-xl bg-surface-inset-base/45 px-3 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[9px] font-medium uppercase tracking-[0.14em] text-text-weak">Avg Q</div>
            <div class="mt-0.5 text-14-semibold tabular-nums text-text-strong">
              {dist().avgCompositeQ >= 0 ? "+" : ""}
              {dist().avgCompositeQ.toFixed(3)}
            </div>
          </div>
          <div class="rounded-xl bg-surface-inset-base/45 px-3 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[9px] font-medium uppercase tracking-[0.14em] text-text-weak">Median Q</div>
            <div class="mt-0.5 text-14-semibold tabular-nums text-text-strong">
              {dist().medianCompositeQ >= 0 ? "+" : ""}
              {dist().medianCompositeQ.toFixed(3)}
            </div>
          </div>
          <div class="rounded-xl bg-surface-inset-base/45 px-3 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[9px] font-medium uppercase tracking-[0.14em] text-text-weak">Never Retrieved</div>
            <div class="mt-0.5 text-14-semibold tabular-nums text-text-strong">{props.rl.neverRetrieved}</div>
          </div>
        </div>

        {/* Distribution bar */}
        <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-3 ring-1 ring-inset ring-border-base/45">
          <div class="flex h-5 overflow-hidden rounded-full">
            {BUCKET_ORDER.map((key) => {
              const style = BUCKET_STYLES[key]!
              const pct = () => (total() > 0 ? (dist()[key] / total()) * 100 : 0)
              return (
                <Show when={pct() > 0}>
                  <div
                    class={`${style.bg} transition-all duration-300`}
                    style={{ width: `${pct()}%` }}
                    title={`${style.label}: ${dist()[key]} (${pct().toFixed(0)}%)`}
                  />
                </Show>
              )
            })}
          </div>
          <div class="mt-2 flex flex-wrap gap-2">
            {BUCKET_ORDER.map((key) => {
              const style = BUCKET_STYLES[key]!
              return (
                <Show when={dist()[key] > 0}>
                  <div class="flex items-center gap-1.5 text-[9px]">
                    <span class={`inline-flex size-2 rounded-sm ${style.bg}`} />
                    <span class={style.text}>
                      {style.label} {dist()[key]}
                    </span>
                  </div>
                </Show>
              )
            })}
          </div>
        </div>

        {/* Retrieval stats */}
        <div class="mt-3 grid grid-cols-2 gap-2">
          <div class="rounded-xl bg-surface-inset-base/45 px-3 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[9px] font-medium uppercase tracking-[0.14em] text-text-weak">Avg Visits</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{props.rl.avgVisits.toFixed(1)}</div>
          </div>
          <div class="rounded-xl bg-surface-inset-base/45 px-3 py-2 ring-1 ring-inset ring-border-base/45">
            <div class="text-[9px] font-medium uppercase tracking-[0.14em] text-text-weak">Frequently Retrieved</div>
            <div class="mt-0.5 text-13-semibold tabular-nums text-text-strong">{props.rl.frequentlyRetrieved}</div>
          </div>
        </div>
      </Show>
    </div>
  )
}

import { For, Show } from "solid-js"

export function RetrievalRanking(props: {
  retrieval: {
    topExperiences: Array<{ id: string; intent: string; scopeID: string; visits: number; compositeQ: number }>
    visitsDistribution: Array<{ range: string; count: number }>
  }
}) {
  const topItems = () => props.retrieval.topExperiences
  const visitsDist = () => props.retrieval.visitsDistribution
  const maxCount = () => Math.max(...visitsDist().map((d) => d.count), 0)

  return (
    <div class="mt-5 rounded-[1.25rem] bg-surface-raised-base/95 p-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.06),inset_0_-1px_0_rgba(24,28,38,0.04)]">
      <div class="px-1 pb-3">
        <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Activity</div>
        <h3 class="mt-1 text-15-semibold text-text-strong tracking-tight">Retrieval Activity</h3>
        <p class="mt-1 text-10-regular text-text-weak">Most-retrieved experiences and visit distribution</p>
      </div>

      <Show
        when={topItems().length > 0}
        fallback={
          <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-5 text-11-regular text-text-weak">
            No retrieval data yet
          </div>
        }
      >
        {/* Top experiences */}
        <div class="flex flex-col gap-2">
          <For each={topItems()}>
            {(item, index) => {
              const qDisplay = () =>
                item.compositeQ >= 0 ? `+${item.compositeQ.toFixed(2)}` : item.compositeQ.toFixed(2)
              const qTone = () =>
                item.compositeQ >= 0.3
                  ? "text-emerald-700 dark:text-emerald-300"
                  : item.compositeQ < 0
                    ? "text-rose-700 dark:text-rose-300"
                    : "text-text-weak"
              return (
                <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-2.5 ring-1 ring-inset ring-border-base/45">
                  <div class="flex items-start gap-3">
                    <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-10-semibold tabular-nums ring-1 ring-inset bg-[rgba(56,88,182,0.12)] text-[rgba(73,103,194,0.96)] ring-[rgba(73,103,194,0.2)]">
                      {index() + 1}
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-11-medium text-text-strong">{item.intent}</div>
                      <div class="mt-1 flex items-center gap-3 text-10-regular text-text-weak">
                        <span class="tabular-nums">{item.visits} visits</span>
                        <span class={`tabular-nums ${qTone()}`}>Q {qDisplay()}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            }}
          </For>
        </div>

        {/* Visits distribution */}
        <Show when={visitsDist().length > 0}>
          <div class="mt-3 rounded-xl bg-surface-inset-base/45 px-3.5 py-3 ring-1 ring-inset ring-border-base/45">
            <div class="text-[9px] font-medium uppercase tracking-[0.14em] text-text-weak mb-2">Visit Distribution</div>
            <div class="flex items-end gap-1.5 h-16">
              <For each={visitsDist()}>
                {(bucket) => {
                  const height = () => (maxCount() > 0 ? Math.max(4, (bucket.count / maxCount()) * 100) : 0)
                  return (
                    <div class="flex flex-1 flex-col items-center gap-1">
                      <div class="text-9-regular tabular-nums text-text-weak">
                        {bucket.count > 0 ? bucket.count : ""}
                      </div>
                      <div
                        class="w-full rounded-t-sm bg-[linear-gradient(180deg,rgba(62,122,98,0.72),rgba(62,122,98,0.38))] transition-all duration-300"
                        style={{ height: `${height()}%` }}
                      />
                      <div class="text-8-medium text-text-weaker whitespace-nowrap">{bucket.range}</div>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}

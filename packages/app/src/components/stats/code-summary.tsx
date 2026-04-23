import { createMemo, createSignal, onMount } from "solid-js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { formatCompact } from "./use-stats"

const ANIMATION_STYLE = `
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
`

function useCountUp(target: number, duration = 800) {
  const [value, setValue] = createSignal(0)
  onMount(() => {
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(eased * target))
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  return value
}

function formatSignedCompact(value: number) {
  if (value > 0) return `+${formatCompact(value)}`
  if (value < 0) return `-${formatCompact(Math.abs(value))}`
  return "0"
}

function ratio(value: number, total: number) {
  if (total <= 0 || value <= 0) return 0
  return Math.max(0, Math.min(100, (value / total) * 100))
}

function CompactStat(props: { label: string; value: string; hint: string }) {
  return (
    <div class="rounded-[1.05rem] bg-surface-base/34 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.06)]">
      <div class="text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker">{props.label}</div>
      <div class="mt-1 text-16-semibold tabular-nums tracking-tight text-text-base">{props.value}</div>
      <div class="mt-1 text-10-regular leading-4 text-text-weak">{props.hint}</div>
    </div>
  )
}

function CompositionRow(props: { label: string; value: string; share: number; tone: "emerald" | "rose" }) {
  const toneClasses = () =>
    props.tone === "emerald"
      ? {
          text: "text-emerald-400",
          dot: "bg-emerald-400",
          bar: "from-emerald-500 to-teal-400",
        }
      : {
          text: "text-rose-400",
          dot: "bg-rose-400",
          bar: "from-rose-500 to-orange-400",
        }

  return (
    <div class="rounded-[1rem] bg-surface-base/38 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.06)]">
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-2">
          <span class={`size-2 rounded-full ${toneClasses().dot}`} />
          <span class="text-11-medium text-text-base">{props.label}</span>
        </div>
        <div class={`text-13-semibold tabular-nums tracking-tight ${toneClasses().text}`}>{props.value}</div>
      </div>
      <div class="mt-2 flex items-center justify-between gap-3 text-[10px] font-medium text-text-weaker">
        <span>{Math.round(props.share)}% of total change volume</span>
        <span>{props.share > 0 ? `${Math.round(props.share)}%` : "0%"}</span>
      </div>
      <div class="mt-2 h-2 rounded-full bg-surface-inset-base/70 p-0.5">
        <div
          class={`h-full rounded-full bg-gradient-to-r transition-[width] duration-700 ${toneClasses().bar}`}
          style={{ width: `${Math.max(props.share, props.share > 0 ? 8 : 0)}%` }}
        />
      </div>
    </div>
  )
}

export function CodeSummary(props: { codeChanges: StatsSnapshot["codeChanges"] }) {
  const added = useCountUp(props.codeChanges.totalAdditions)
  const removed = useCountUp(props.codeChanges.totalDeletions)
  const net = useCountUp(Math.abs(props.codeChanges.netLines))

  const totalChanged = createMemo(() => props.codeChanges.totalAdditions + props.codeChanges.totalDeletions)
  const addShare = createMemo(() => ratio(props.codeChanges.totalAdditions, totalChanged()))
  const removeShare = createMemo(() => ratio(props.codeChanges.totalDeletions, totalChanged()))
  const averagePerDay = createMemo(() => formatSignedCompact(Math.round(props.codeChanges.dailyAdditions)))
  const averageRemovedPerDay = createMemo(() => formatSignedCompact(-Math.round(props.codeChanges.dailyDeletions)))
  const throughput = createMemo(() => {
    const files = Math.max(props.codeChanges.totalFiles, 1)
    return formatCompact(Math.round(totalChanged() / files))
  })
  const growthLine = createMemo(() => {
    if (props.codeChanges.netLines > 0) return "Growth outpaced cleanup"
    if (props.codeChanges.netLines < 0) return "Cleanup outpaced new code"
    return "Additions and removals stayed balanced"
  })
  const compositionLine = createMemo(() => {
    const changed = totalChanged()
    if (changed <= 0) return "No tracked code movement yet"
    return `${formatCompact(changed)} lines moved overall`
  })

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <div class="mt-5 mb-3 px-1 text-12-medium text-text-weak">Code Changes</div>
      <section
        class="rounded-2xl bg-surface-raised-base px-4 py-4"
        style={{ animation: "fadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
      >
        <div class="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
          <div class="rounded-[1.35rem] bg-[linear-gradient(135deg,rgba(70,124,102,0.16),rgba(42,54,72,0.06)_42%,rgba(193,136,84,0.1))] p-[1px] shadow-[0_18px_45px_rgba(26,31,43,0.12)]">
            <div class="rounded-[calc(1.35rem-1px)] bg-surface-base/74 px-4 py-4 backdrop-blur-sm">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div class="min-w-0 flex-1">
                  <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-weaker">
                    Net code growth
                  </div>
                  <div class="mt-2 text-32-semibold tracking-tight tabular-nums text-text-strong">
                    {props.codeChanges.netLines >= 0 ? "+" : "-"}
                    {formatCompact(net())}
                  </div>
                  <div class="mt-1 text-11-regular text-text-weak">{growthLine()}</div>
                </div>
                <div class="rounded-[1rem] bg-surface-base/55 px-3.5 py-2.5 text-right shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
                  <div class="text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker">Code flow</div>
                  <div class="mt-1 text-15-semibold tabular-nums tracking-tight text-text-base">
                    {formatSignedCompact(props.codeChanges.netLines)}
                  </div>
                  <div class="text-10-regular text-text-weak">{compositionLine()}</div>
                </div>
              </div>

              <div class="mt-5 rounded-[1.05rem] bg-surface-base/34 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.06)]">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker">
                      Added vs removed
                    </div>
                    <div class="mt-1 text-11-regular text-text-weak">How the overall movement breaks down</div>
                  </div>
                  <div class="text-right text-[10px] font-medium text-text-weaker">
                    <div>{Math.round(addShare())}% added</div>
                    <div>{Math.round(removeShare())}% removed</div>
                  </div>
                </div>
                <div class="mt-3 h-3 overflow-hidden rounded-full bg-surface-inset-base/72 p-0.5">
                  <div class="flex h-full gap-0.5">
                    <div
                      class="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400"
                      style={{ width: `${Math.max(addShare(), addShare() > 0 ? 6 : 0)}%` }}
                    />
                    <div
                      class="h-full rounded-full bg-gradient-to-r from-rose-500 to-orange-400"
                      style={{ width: `${Math.max(removeShare(), removeShare() > 0 ? 6 : 0)}%` }}
                    />
                  </div>
                </div>
              </div>

              <div class="mt-4 grid gap-3 md:grid-cols-2">
                <CompositionRow
                  label="Lines added"
                  tone="emerald"
                  value={`+${formatCompact(added())}`}
                  share={addShare()}
                />
                <CompositionRow
                  label="Lines removed"
                  tone="rose"
                  value={`-${formatCompact(removed())}`}
                  share={removeShare()}
                />
              </div>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
            <CompactStat
              label="Files touched"
              value={formatCompact(props.codeChanges.totalFiles)}
              hint="Distinct files changed across tracked sessions"
            />
            <CompactStat label="Adds / day" value={averagePerDay()} hint="Average added lines per active coding day" />
            <CompactStat
              label="Removals / day"
              value={averageRemovedPerDay()}
              hint="Average removed lines per active coding day"
            />
            <CompactStat label="Lines / file" value={throughput()} hint="Average touched lines per modified file" />
          </div>
        </div>
      </section>
    </>
  )
}

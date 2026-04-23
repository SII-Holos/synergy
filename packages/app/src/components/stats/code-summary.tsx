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

function ratioWidth(value: number, total: number) {
  if (total <= 0 || value <= 0) return 0
  return Math.max(8, Math.min(100, (value / total) * 100))
}

function PulseMetric(props: {
  label: string
  tone: "emerald" | "rose" | "neutral"
  value: string
  hint: string
  width: number
}) {
  const toneClasses = () => {
    if (props.tone === "emerald") {
      return {
        text: "text-emerald-400",
        bar: "from-emerald-500/80 via-emerald-400/75 to-teal-300/65",
        glow: "shadow-[0_10px_28px_rgba(51,132,114,0.18)]",
      }
    }
    if (props.tone === "rose") {
      return {
        text: "text-rose-400",
        bar: "from-rose-500/78 via-rose-400/72 to-orange-300/62",
        glow: "shadow-[0_10px_28px_rgba(190,80,109,0.16)]",
      }
    }
    return {
      text: "text-text-strong",
      bar: "from-sky-500/72 via-indigo-400/62 to-violet-300/58",
      glow: "shadow-[0_10px_28px_rgba(86,110,186,0.14)]",
    }
  }

  return (
    <div class="rounded-[1.35rem] bg-surface-base/42 px-4 py-3.5 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker">{props.label}</div>
          <div class={`mt-2 text-24-semibold tracking-tight tabular-nums ${toneClasses().text}`}>{props.value}</div>
          <div class="mt-1 text-10-regular text-text-weak">{props.hint}</div>
        </div>
      </div>
      <div class="mt-3 h-2 rounded-full bg-surface-inset-base/70 p-0.5">
        <div
          class={`h-full rounded-full bg-gradient-to-r transition-[width] duration-700 ${toneClasses().bar} ${toneClasses().glow}`}
          style={{ width: `${props.width}%` }}
        />
      </div>
    </div>
  )
}

function CompactStat(props: { label: string; value: string; hint: string }) {
  return (
    <div class="rounded-[1.2rem] bg-surface-base/34 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.06)]">
      <div class="text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker">{props.label}</div>
      <div class="mt-1 text-16-semibold tabular-nums text-text-base">{props.value}</div>
      <div class="mt-1 text-10-regular text-text-weak">{props.hint}</div>
    </div>
  )
}

export function CodeSummary(props: { codeChanges: StatsSnapshot["codeChanges"] }) {
  const additions = useCountUp(props.codeChanges.totalAdditions)
  const deletions = useCountUp(props.codeChanges.totalDeletions)
  const net = useCountUp(Math.abs(props.codeChanges.netLines))

  const totalChanged = createMemo(() => props.codeChanges.totalAdditions + props.codeChanges.totalDeletions)
  const addShare = createMemo(() => ratioWidth(props.codeChanges.totalAdditions, totalChanged()))
  const deleteShare = createMemo(() => ratioWidth(props.codeChanges.totalDeletions, totalChanged()))
  const averagePerDay = createMemo(() => formatSignedCompact(Math.round(props.codeChanges.dailyAdditions)))
  const averageRemovedPerDay = createMemo(() => formatSignedCompact(-Math.round(props.codeChanges.dailyDeletions)))
  const netTone = createMemo<"emerald" | "rose" | "neutral">(() => {
    if (props.codeChanges.netLines > 0) return "emerald"
    if (props.codeChanges.netLines < 0) return "rose"
    return "neutral"
  })
  const throughput = createMemo(() => {
    const files = Math.max(props.codeChanges.totalFiles, 1)
    return formatCompact(Math.round(totalChanged() / files))
  })

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <div class="mt-5 mb-3 px-1 text-12-medium text-text-weak">Code Changes</div>
      <section
        class="rounded-2xl bg-surface-raised-base px-4 py-4"
        style={{ animation: "fadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
      >
        <div class="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div class="rounded-[1.5rem] bg-[linear-gradient(135deg,rgba(70,124,102,0.18),rgba(42,54,72,0.08)_45%,rgba(193,136,84,0.12))] p-[1px] shadow-[0_18px_45px_rgba(26,31,43,0.12)]">
            <div class="rounded-[calc(1.5rem-1px)] bg-surface-base/72 px-4 py-4 backdrop-blur-sm">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-weaker">
                    Net Code Growth
                  </div>
                  <div class="mt-2 text-32-semibold tracking-tight tabular-nums text-text-strong">
                    {props.codeChanges.netLines >= 0 ? "+" : "-"}
                    {formatCompact(net())}
                  </div>
                  <div class="mt-1 text-11-regular text-text-weak">
                    {props.codeChanges.netLines >= 0
                      ? "More code shipped than removed"
                      : "More code removed than shipped"}
                  </div>
                </div>
                <div class="rounded-2xl bg-surface-base/55 px-3 py-2 text-right shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
                  <div class="text-[10px] font-medium uppercase tracking-[0.16em] text-text-weaker">Change Mix</div>
                  <div class="mt-1 text-15-semibold tabular-nums text-text-base">{formatCompact(totalChanged())}</div>
                  <div class="text-10-regular text-text-weak">total lines touched</div>
                </div>
              </div>

              <div class="mt-5 space-y-3">
                <PulseMetric
                  label="Lines added"
                  tone="emerald"
                  value={`+${formatCompact(additions())}`}
                  hint={`${Math.round((props.codeChanges.totalAdditions / Math.max(totalChanged(), 1)) * 100)}% of total change volume`}
                  width={addShare()}
                />
                <PulseMetric
                  label="Lines removed"
                  tone="rose"
                  value={`-${formatCompact(deletions())}`}
                  hint={`${Math.round((props.codeChanges.totalDeletions / Math.max(totalChanged(), 1)) * 100)}% of total change volume`}
                  width={deleteShare()}
                />
                <PulseMetric
                  label="Net balance"
                  tone={netTone()}
                  value={formatSignedCompact(props.codeChanges.netLines)}
                  hint={
                    props.codeChanges.netLines >= 0
                      ? "Growth remained positive overall"
                      : "Cleanup outweighed additions overall"
                  }
                  width={ratioWidth(
                    Math.abs(props.codeChanges.netLines),
                    Math.max(totalChanged(), Math.abs(props.codeChanges.netLines)),
                  )}
                />
              </div>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <CompactStat
              label="Files touched"
              value={formatCompact(props.codeChanges.totalFiles)}
              hint="Distinct files changed across tracked sessions"
            />
            <CompactStat
              label="Avg adds / day"
              value={averagePerDay()}
              hint="Average added lines per active coding day"
            />
            <CompactStat
              label="Avg removals / day"
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

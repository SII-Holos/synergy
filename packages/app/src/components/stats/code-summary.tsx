import { createSignal, onMount } from "solid-js"
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

function MetricBlock(props: { label: string; value: string; valueClass: string }) {
  return (
    <div class="flex min-h-[5.75rem] flex-col justify-between rounded-2xl bg-surface-base/50 px-3.5 py-3.5">
      <span class="text-11-medium leading-snug text-text-weak">{props.label}</span>
      <span class={`text-24-semibold tracking-tight tabular-nums ${props.valueClass}`}>{props.value}</span>
    </div>
  )
}

function FooterStat(props: { label: string; value: string }) {
  return (
    <div class="rounded-2xl bg-surface-base/38 px-3.5 py-3">
      <div class="text-[10px] font-medium uppercase tracking-[0.14em] text-text-weak">{props.label}</div>
      <div class="mt-1 text-13-medium tabular-nums text-text-base">{props.value}</div>
    </div>
  )
}

export function CodeSummary(props: { codeChanges: StatsSnapshot["codeChanges"] }) {
  const additions = useCountUp(props.codeChanges.totalAdditions)
  const deletions = useCountUp(props.codeChanges.totalDeletions)
  const net = useCountUp(props.codeChanges.netLines)

  const averagePerDay = () => formatSignedCompact(Math.round(props.codeChanges.dailyAdditions))
  const netClass = () => (props.codeChanges.netLines < 0 ? "text-rose-400" : "text-text-strong")

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <div class="mt-5 mb-3 px-1 text-12-medium text-text-weak">Code Changes</div>
      <section
        class="mt-5 rounded-2xl bg-surface-raised-base px-4 py-4"
        style={{ animation: "fadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
      >
        <div class="grid grid-cols-3 gap-3.5">
          <MetricBlock label="Lines added" value={`+${formatCompact(additions())}`} valueClass="text-emerald-400" />
          <MetricBlock label="Lines removed" value={`-${formatCompact(deletions())}`} valueClass="text-rose-400" />
          <MetricBlock label="Net code growth" value={formatSignedCompact(net())} valueClass={netClass()} />
        </div>
        <div class="mt-4 grid grid-cols-1 gap-2.5 border-t border-border-weaker-base/40 pt-4 sm:grid-cols-2">
          <FooterStat label="Files touched" value={formatCompact(props.codeChanges.totalFiles)} />
          <FooterStat label="Average additions per day" value={averagePerDay()} />
        </div>
      </section>
    </>
  )
}

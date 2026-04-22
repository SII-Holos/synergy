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

export function CodeSummary(props: { codeChanges: StatsSnapshot["codeChanges"] }) {
  const additions = useCountUp(props.codeChanges.totalAdditions)
  const deletions = useCountUp(props.codeChanges.totalDeletions)
  const net = useCountUp(props.codeChanges.netLines)

  const netColor = () => (props.codeChanges.netLines < 0 ? "text-rose-400" : "text-text-strong")

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <div class="text-12-medium text-text-weak mt-5 mb-3 px-1">💻 Code Changes</div>
      <div
        class="bg-surface-raised-base rounded-xl p-4 mt-5"
        style={{ animation: "fadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
      >
        <div class="flex justify-between">
          <div class="flex flex-col items-center flex-1">
            <span class="text-16-semibold text-emerald-400 tabular-nums">+{formatCompact(additions())}</span>
            <span class="text-10-medium text-text-weak">additions</span>
          </div>
          <div class="flex flex-col items-center flex-1">
            <span class="text-16-semibold text-rose-400 tabular-nums">-{formatCompact(deletions())}</span>
            <span class="text-10-medium text-text-weak">deletions</span>
          </div>
          <div class="flex flex-col items-center flex-1">
            <span class={`text-16-semibold tabular-nums ${netColor()}`}>{formatCompact(net())} net</span>
            <span class="text-10-medium text-text-weak">lines</span>
          </div>
        </div>
        <div class="text-11-regular text-text-weakest mt-2">
          {formatCompact(props.codeChanges.totalFiles)} files · +
          {formatCompact(Math.round(props.codeChanges.dailyAdditions))}/day
        </div>
      </div>
    </>
  )
}

import { createSignal, onMount } from "solid-js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { formatCompact, formatCost } from "./use-stats"

const ANIMATION_STYLE = `
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes pulse-fire {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); }
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

function StatCard(props: { value: string; label: string; delay: number }) {
  return (
    <div
      class="bg-surface-raised-base rounded-xl p-3 flex flex-col items-center gap-1"
      style={{ animation: `fadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) ${props.delay}ms both` }}
    >
      <span class="text-20-semibold text-text-strong tabular-nums">{props.value}</span>
      <span class="text-10-medium text-text-weak uppercase tracking-wide">{props.label}</span>
    </div>
  )
}

export function OverviewCards(props: { overview: StatsSnapshot["overview"]; tokenCost: StatsSnapshot["tokenCost"] }) {
  const sessions = useCountUp(props.overview.totalSessions)
  const cost = useCountUp(Math.round(props.tokenCost.cost * 100))
  const days = useCountUp(props.overview.totalDays)

  const costDisplay = () => {
    const raw = cost() / 100
    return formatCost(raw)
  }

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <div class="flex gap-2">
        <StatCard value={formatCompact(sessions())} label="sessions" delay={0} />
        <StatCard value={costDisplay()} label="cost" delay={60} />
        <StatCard value={days().toString()} label="days" delay={120} />
      </div>
      {props.overview.currentStreak > 0 && (
        <div class="flex items-center justify-center gap-1 text-12-medium text-text-weak">
          <span style={{ animation: "pulse-fire 1.5s ease-in-out infinite", display: "inline-block" }}>🔥</span>
          {props.overview.currentStreak}-day streak
        </div>
      )}
    </>
  )
}

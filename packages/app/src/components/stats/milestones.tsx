import { Show } from "solid-js"
import type { StatsSnapshot } from "@ericsanchezok/synergy-sdk"
import { formatCompact, formatCost } from "./use-stats"

interface Milestone {
  icon: string
  label: string
  unlocked: boolean
}

function computeMilestones(snapshot: StatsSnapshot): Milestone[] {
  const { overview, tokenCost, codeChanges } = snapshot
  const totalTokens =
    tokenCost.tokens.input +
    tokenCost.tokens.output +
    tokenCost.tokens.reasoning +
    tokenCost.tokens.cache.read +
    tokenCost.tokens.cache.write

  return [
    { icon: "🎯", label: `${formatCompact(overview.totalSessions)} Sessions`, unlocked: overview.totalSessions >= 100 },
    { icon: "💬", label: `${formatCompact(overview.totalTurns)} Turns`, unlocked: overview.totalTurns >= 500 },
    { icon: "💰", label: `${formatCost(tokenCost.cost)} Spent`, unlocked: tokenCost.cost >= 10 },
    { icon: "🔥", label: `${overview.longestStreak}-day Streak`, unlocked: overview.longestStreak >= 7 },
    { icon: "🧠", label: `${formatCompact(totalTokens)} Tokens`, unlocked: totalTokens >= 1_000_000 },
    {
      icon: "💻",
      label: `${formatCompact(codeChanges.totalAdditions)} Lines Added`,
      unlocked: codeChanges.totalAdditions >= 10_000,
    },
    { icon: "📁", label: `${overview.projectCount} Projects`, unlocked: overview.projectCount >= 5 },
  ]
}

export function Milestones(props: { snapshot: StatsSnapshot }) {
  const milestones = () => computeMilestones(props.snapshot)
  const unlocked = () => milestones().filter((m) => m.unlocked)
  const locked = () => milestones().filter((m) => !m.unlocked)

  return (
    <>
      <style>{`
        @keyframes milestonePop {
          from { opacity: 0; transform: scale(0.8); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div class="mt-5 px-1">
        <span class="text-12-medium text-text-weak">🏆 Milestones</span>
      </div>
      <div class="bg-surface-raised-base rounded-xl p-3 mt-3">
        <div class="flex flex-wrap gap-2">
          {unlocked().map((m, i) => (
            <div
              class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-inset-base/50"
              style={{
                animation: `milestonePop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both`,
                "animation-delay": `${i * 60}ms`,
              }}
            >
              <span class="text-13">{m.icon}</span>
              <span class="text-11-medium text-text-base">{m.label}</span>
            </div>
          ))}
          <Show when={locked().length > 0}>
            {locked().map((m, i) => (
              <div
                class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-inset-base/20 opacity-40"
                style={{
                  animation: `milestonePop 0.3s ease-out both`,
                  "animation-delay": `${(unlocked().length + i) * 40}ms`,
                }}
              >
                <span class="text-13 grayscale">{m.icon}</span>
                <span class="text-11-regular text-text-weakest">{m.label}</span>
              </div>
            ))}
          </Show>
        </div>
      </div>
    </>
  )
}

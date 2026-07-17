import { For } from "solid-js"
import { useLocale } from "@/context/locale"
import type { OverviewMetric } from "./model"
import { S } from "./stats-i18n"
const ANIMATION_STYLE = `
@keyframes overviewCardEnter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`

function dayLabel(days: number, i18n: ReturnType<typeof useLocale>["i18n"]) {
  return i18n._(S.overviewDayLabel.id, { count: days })
}
function MetricCard(props: { metric: OverviewMetric; delay: number }) {
  return (
    <div
      class="rounded-2xl bg-surface-raised-base/95 px-3.5 py-3 ring-1 ring-inset ring-border-weaker-base"
      style={{ animation: `overviewCardEnter 0.32s ease-out ${props.delay}ms both` }}
    >
      <div class="flex min-h-[5.5rem] flex-col justify-between gap-2">
        <span class="text-22-semibold text-text-strong tracking-tight tabular-nums">{props.metric.value}</span>
        <span class="text-10-medium uppercase tracking-[0.16em] text-text-weaker">{props.metric.label}</span>
        <span class="mt-1 line-clamp-1 text-10-regular text-text-weak">{props.metric.hint ?? "—"}</span>
      </div>
    </div>
  )
}

function StreakItem(props: {
  label: string
  value: number
  i18n: ReturnType<typeof useLocale>["i18n"]
  delay: number
}) {
  return (
    <div style={{ animation: `overviewCardEnter 0.32s ease-out ${props.delay}ms both` }}>
      <span class="text-11-medium text-text-weak">{props.label}</span>
      <span class="ml-1.5 text-11-semibold text-text-strong tabular-nums">{dayLabel(props.value, props.i18n)}</span>
    </div>
  )
}

export function OverviewCards(props: {
  metrics: OverviewMetric[]
  streak: { current: number; longest: number }
  streakCurrentLabel?: string
  streakBestLabel?: string
}) {
  const { i18n } = useLocale()
  const metrics = () => props.metrics.slice(0, 6)
  const currentLabel = () => props.streakCurrentLabel ?? i18n._(S.overviewStreakCurrentLong.id)
  const bestLabel = () => props.streakBestLabel ?? i18n._(S.overviewStreakBestLong.id)

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <section class="rounded-2xl bg-surface-raised-base p-2.5">
        <div class="mt-4 grid grid-cols-3 gap-2.5">
          <For each={metrics()}>{(metric, index) => <MetricCard metric={metric} delay={index() * 40} />}</For>
        </div>
        <div
          class="mt-2 flex items-center justify-between rounded-xl bg-surface-warning-weak px-3 py-1.5"
          style={{ animation: `overviewCardEnter 0.32s ease-out ${metrics().length * 40}ms both` }}
        >
          <StreakItem label={currentLabel()} value={props.streak.current} i18n={i18n} delay={0} />
          <StreakItem label={bestLabel()} value={props.streak.longest} i18n={i18n} delay={40} />
        </div>
      </section>
    </>
  )
}

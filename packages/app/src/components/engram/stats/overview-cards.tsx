import { For } from "solid-js"

type OverviewMetric = {
  id: string
  label: string
  value: string
  hint?: string
}

function buildMetrics(overview: {
  totalMemories: number
  totalExperiences: number
  memoriesEdited: number
  experiencesEvaluated: number
  experiencesFailed: number
  experiencesPending: number
  scopeCount: number
  activeDays: number
}): OverviewMetric[] {
  return [
    {
      id: "memories",
      label: "Memories",
      value: overview.totalMemories.toLocaleString(),
      hint: `${overview.memoriesEdited} edited`,
    },
    {
      id: "experiences",
      label: "Experiences",
      value: overview.totalExperiences.toLocaleString(),
      hint: `${overview.experiencesEvaluated} evaluated · ${overview.experiencesPending} pending`,
    },
    {
      id: "evaluated",
      label: "Evaluated",
      value: overview.experiencesEvaluated.toLocaleString(),
      hint: overview.experiencesFailed > 0 ? `${overview.experiencesFailed} failed` : undefined,
    },
    {
      id: "scopes",
      label: "Scopes",
      value: overview.scopeCount.toString(),
      hint: `${overview.activeDays} active days`,
    },
  ]
}

const ANIMATION_STYLE = `
@keyframes overviewCardEnter {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
`

function MetricCard(props: { metric: OverviewMetric; delay: number }) {
  return (
    <div
      class="rounded-2xl bg-surface-raised-base/95 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_-1px_0_rgba(255,255,255,0.03)]"
      style={{ animation: `overviewCardEnter 0.32s ease-out ${props.delay}ms both` }}
    >
      <div class="flex min-h-[4.5rem] flex-col justify-between gap-2">
        <span class="text-22-semibold text-text-strong tracking-tight tabular-nums">{props.metric.value}</span>
        <span class="text-10-medium uppercase tracking-[0.16em] text-text-weaker">{props.metric.label}</span>
        <span class="mt-1 line-clamp-1 text-10-regular text-text-weak">{props.metric.hint ?? "—"}</span>
      </div>
    </div>
  )
}

export function EngramOverviewCards(props: {
  overview: {
    totalMemories: number
    totalExperiences: number
    memoriesEdited: number
    experiencesEvaluated: number
    experiencesFailed: number
    experiencesPending: number
    scopeCount: number
    activeDays: number
  }
}) {
  const metrics = () => buildMetrics(props.overview)

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <section class="rounded-2xl bg-surface-raised-base p-2.5">
        <div class="mt-4 grid grid-cols-4 gap-2.5">
          <For each={metrics()}>{(metric, index) => <MetricCard metric={metric} delay={index() * 40} />}</For>
        </div>
      </section>
    </>
  )
}

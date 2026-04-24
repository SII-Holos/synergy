import { For } from "solid-js"

type OverviewMetric = {
  id: string
  label: string
  value: string
  sub?: string
}

function buildMetrics(overview: {
  totalMemories: number
  totalExperiences: number
  evaluationRate: number
  experiencesEvaluated: number
  experiencesFailed: number
  experiencesPending: number
  scopeCount: number
  activeDays: number
}): OverviewMetric[] {
  const ratePct = overview.evaluationRate >= 0 ? `${(overview.evaluationRate * 100).toFixed(0)}%` : "—"
  return [
    {
      id: "memories",
      label: "Memories",
      value: overview.totalMemories.toLocaleString(),
      sub: `${overview.scopeCount} scopes`,
    },
    {
      id: "experiences",
      label: "Experiences",
      value: overview.totalExperiences.toLocaleString(),
      sub: `${overview.experiencesEvaluated} eval · ${overview.experiencesPending} pend`,
    },
    {
      id: "eval-rate",
      label: "Eval Rate",
      value: ratePct,
      sub: overview.experiencesFailed > 0 ? `${overview.experiencesFailed} failed` : undefined,
    },
    {
      id: "active",
      label: "Active Days",
      value: overview.activeDays.toString(),
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
      <div class="flex min-h-[3.5rem] flex-col justify-between gap-1.5">
        <span class="text-22-semibold text-text-strong tracking-tight tabular-nums">{props.metric.value}</span>
        <span class="text-10-medium uppercase tracking-[0.16em] text-text-weaker">{props.metric.label}</span>
        {props.metric.sub ? <span class="text-10-regular text-text-weak">{props.metric.sub}</span> : null}
      </div>
    </div>
  )
}

export function EngramOverviewCards(props: {
  overview: {
    totalMemories: number
    totalExperiences: number
    evaluationRate: number
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
        <div class="grid grid-cols-4 gap-2.5">
          <For each={metrics()}>{(metric, index) => <MetricCard metric={metric} delay={index() * 40} />}</For>
        </div>
      </section>
    </>
  )
}

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
      label: "Eval rate",
      value: ratePct,
      sub: overview.experiencesFailed > 0 ? `${overview.experiencesFailed} failed` : undefined,
    },
    {
      id: "active",
      label: "Active days",
      value: overview.activeDays.toString(),
    },
  ]
}

function MetricCard(props: { metric: OverviewMetric; delay: number }) {
  return (
    <div class="library-metric-card" style={{ animation: `overviewCardEnter 0.28s ease-out ${props.delay}ms both` }}>
      <div class="flex items-baseline gap-2">
        <span class="text-18-semibold text-text-strong tabular-nums">{props.metric.value}</span>
        <span class="text-11-regular text-text-weak">{props.metric.label}</span>
      </div>
      {props.metric.sub ? <div class="mt-0.5 text-10-regular text-text-weaker">{props.metric.sub}</div> : null}
    </div>
  )
}

export function LibraryOverviewCards(props: {
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
      <style>{`@keyframes overviewCardEnter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div class="library-metric-grid">
        <For each={metrics()}>{(metric, index) => <MetricCard metric={metric} delay={index() * 40} />}</For>
      </div>
    </>
  )
}

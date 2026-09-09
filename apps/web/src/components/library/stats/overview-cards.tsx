import { For } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useLocale } from "@/context/locale"

type OverviewMetric = {
  id: string
  label: string
  value: string
  sub?: string
}

function buildMetrics(
  overview: {
    totalMemories: number
    totalExperiences: number
    evaluationRate: number
    experiencesEvaluated: number
    experiencesFailed: number
    experiencesPending: number
    scopeCount: number
    activeDays: number
  },
  _: ReturnType<typeof useLingui>["_"],
  fmt: ReturnType<typeof useLocale>["fmt"],
): OverviewMetric[] {
  const ratePct = overview.evaluationRate >= 0 ? `${(overview.evaluationRate * 100).toFixed(0)}%` : "—"
  return [
    {
      id: "memories",
      label: _({ id: "app.library.stats.overview.memories", message: "Memories" }),
      value: fmt.number(overview.totalMemories),
      sub: _({
        id: "app.library.stats.overview.scopeCount",
        message: "{count} scopes",
        values: { count: String(overview.scopeCount) },
      }),
    },
    {
      id: "experiences",
      label: _({ id: "app.library.stats.overview.experiences", message: "Experiences" }),
      value: fmt.number(overview.totalExperiences),
      sub: _({
        id: "app.library.stats.overview.experienceDetails",
        message: "{evaluated} eval · {pending} pend",
        values: { evaluated: String(overview.experiencesEvaluated), pending: String(overview.experiencesPending) },
      }),
    },
    {
      id: "eval-rate",
      label: _({ id: "app.library.stats.overview.evalRate", message: "Eval rate" }),
      value: ratePct,
      sub:
        overview.experiencesFailed > 0
          ? _({
              id: "app.library.stats.overview.failed",
              message: "{count} failed",
              values: { count: String(overview.experiencesFailed) },
            })
          : undefined,
    },
    {
      id: "active",
      label: _({ id: "app.library.stats.overview.activeDays", message: "Active days" }),
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
  const { _ } = useLingui()
  const { fmt } = useLocale()
  const metrics = () => buildMetrics(props.overview, _, fmt)

  return (
    <>
      <style>{`@keyframes overviewCardEnter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div class="library-metric-grid">
        <For each={metrics()}>{(metric, index) => <MetricCard metric={metric} delay={index() * 40} />}</For>
      </div>
    </>
  )
}

import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import type { RankingMetric, RankingRow } from "./model"
import { formatCompact, formatCost } from "./use-stats"
import { S } from "./stats-i18n"

type LegacyRankItem = {
  id: string
  label: string
  value: number
  detail?: string
  sublabel?: string
}

type RankListProps =
  | {
      title: string
      description: string
      metrics: RankingMetric[]
      rows: RankingRow[]
      defaultMetric?: string
      defaultTop?: number
    }
  | {
      title: string
      icon?: string
      items: LegacyRankItem[]
      defaultTop?: number
    }

const ANIMATION_STYLE = `
@keyframes rankListEnter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`

const LEGACY_METRIC: RankingMetric = {
  id: "value",
  label: S.rankLegacyValue,
  unit: "",
  color: "indigo",
}

const ACTIVE_METRIC_CLASSES = "bg-surface-interactive-selected text-text-base ring-border-selected"
const METRIC_SERIES = {
  indigo: {
    rail: "color-mix(in srgb, var(--chart-series-1) 14%, transparent)",
    bar: "var(--chart-series-1)",
  },
  emerald: {
    rail: "color-mix(in srgb, var(--chart-series-3) 14%, transparent)",
    bar: "var(--chart-series-3)",
  },
  amber: {
    rail: "color-mix(in srgb, var(--chart-series-4) 14%, transparent)",
    bar: "var(--chart-series-4)",
  },
  rose: {
    rail: "color-mix(in srgb, var(--chart-series-7) 14%, transparent)",
    bar: "var(--chart-series-7)",
  },
} satisfies Record<RankingMetric["color"], { rail: string; bar: string }>

function isNewProps(props: RankListProps): props is Extract<RankListProps, { rows: RankingRow[] }> {
  return "rows" in props
}

function normalizeProps(props: RankListProps, i18n: ReturnType<typeof useLocale>["i18n"]) {
  if (isNewProps(props)) return props
  return {
    title: props.title,
    description: i18n._(S.rankFallbackDesc.id),
    metrics: [LEGACY_METRIC],
    rows: props.items.map((item) => ({
      id: item.id,
      label: item.label,
      primary: item.sublabel ?? "",
      secondary: item.detail,
      values: { value: item.value },
    })),
    defaultMetric: LEGACY_METRIC.id,
    defaultTop: props.defaultTop,
  }
}

function trimDecimal(value: number, digits = 1) {
  return value.toFixed(digits).replace(/\.0$/, "")
}

function formatCount(value: number, fmt: (n: number) => string) {
  if (Math.abs(value) >= 100_000) return formatCompact(value)
  return fmt(Math.round(value))
}

function metricLabel(metric: RankingMetric, i18n: ReturnType<typeof useLocale>["i18n"]): string {
  return translateDescriptor(metric.label, i18n)
}

function formatMetricValue(
  metric: RankingMetric,
  raw: number,
  fmt: (n: number) => string,
  i18n: ReturnType<typeof useLocale>["i18n"],
  mode: "full" | "compact" = "full",
) {
  const value = Number.isFinite(raw) ? raw : 0
  if (metric.unit === "usd") return formatCost(value)
  if (metric.unit === "%")
    return `${value >= 10 ? Math.round(value) : trimDecimal(value)}% ${mode === "full" ? metricLabel(metric, i18n).toLowerCase() : ""}`.trim()
  if (metric.unit === "ms") {
    if (value >= 1000) return i18n._(S.rankAvgSec.id, { value: trimDecimal(value / 1000) })
    return i18n._(S.rankAvgMs.id, { value: String(Math.round(value)) })
  }
  if (!metric.unit) return formatCount(value, fmt)
  return `${formatCount(value, fmt)} ${metric.unit}`
}

function metricUnitLabel(metric: RankingMetric, i18n: ReturnType<typeof useLocale>["i18n"]) {
  if (metric.unit === "usd") return i18n._(S.rankMetricUSD.id)
  if (metric.unit === "%") return i18n._(S.rankMetricRate.id)
  if (metric.unit === "ms") return i18n._(S.rankMetricTime.id)
  return metric.unit
}

function sortedByMetric(rows: RankingRow[], metricID: string) {
  return [...rows].sort((a, b) => {
    const delta = (b.values[metricID] ?? 0) - (a.values[metricID] ?? 0)
    if (delta !== 0) return delta
    return a.label.localeCompare(b.label)
  })
}

export function RankList(props: RankListProps) {
  const { i18n, fmt } = useLocale()
  const normalized = createMemo(() => normalizeProps(props, i18n))
  const [state, setState] = createStore({
    activeMetricID: isNewProps(props)
      ? (props.defaultMetric ?? props.metrics[0]?.id ?? LEGACY_METRIC.id)
      : LEGACY_METRIC.id,
    expanded: false,
  })

  const top = createMemo(() => Math.max(1, normalized().defaultTop ?? 5))
  const metrics = createMemo(() => normalized().metrics)
  const activeMetric = createMemo(
    () => metrics().find((metric) => metric.id === state.activeMetricID) ?? metrics()[0] ?? LEGACY_METRIC,
  )
  const metricSeries = createMemo(() => METRIC_SERIES[activeMetric().color])
  const sortedRows = createMemo(() => sortedByMetric(normalized().rows, activeMetric().id))
  const visibleRows = createMemo(() => (state.expanded ? sortedRows() : sortedRows().slice(0, top())))
  const hiddenCount = createMemo(() => Math.max(0, sortedRows().length - top()))
  const maxValue = createMemo(() => Math.max(...sortedRows().map((row) => row.values[activeMetric().id] ?? 0), 0))
  const description = createMemo(() => {
    const text = normalized().description.trim()
    const unit = metricUnitLabel(activeMetric(), i18n)
    const sortHint = i18n._(S.rankSortedBy.id, {
      metric: metricLabel(activeMetric(), i18n).toLowerCase(),
      unit: unit ? ` · ${unit}` : "",
    })
    return text ? `${text} · ${sortHint}` : sortHint
  })

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <section class="rounded-[1.25rem] bg-surface-raised-base/95 p-3 ring-1 ring-inset ring-border-weaker-base">
        <div class="flex items-start justify-between gap-4 px-1 pb-3">
          <div class="min-w-0">
            <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">
              {i18n._(S.rankLabel.id)}
            </div>
            <h3 class="mt-1 text-15-semibold text-text-strong tracking-tight">{normalized().title}</h3>
            <p class="mt-1 text-10-regular text-text-weak line-clamp-2">{description()}</p>
          </div>
          <div
            class={`hidden rounded-full px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.16em] ring-1 ring-inset md:block ${ACTIVE_METRIC_CLASSES}`}
          >
            {metricLabel(activeMetric(), i18n)}
          </div>
        </div>

        <div class="mb-3 flex flex-wrap gap-1.5">
          <For each={metrics()}>
            {(metric) => {
              const isActive = () => activeMetric().id === metric.id
              return (
                <button
                  type="button"
                  class={`rounded-full px-2.5 py-1.5 text-10-medium ring-1 ring-inset transition-all ${
                    isActive()
                      ? ACTIVE_METRIC_CLASSES
                      : "bg-surface-inset-base/65 text-text-weak ring-border-base/45 hover:bg-surface-inset-base hover:text-text-base"
                  }`}
                  onClick={() => setState({ activeMetricID: metric.id, expanded: false })}
                >
                  <span>{metricLabel(metric, i18n)}</span>
                  <span class="ml-1.5 text-[9px] uppercase tracking-[0.12em] opacity-70">
                    {metric.unit || i18n._(S.rankMetricUnit.id)}
                  </span>
                </button>
              )
            }}
          </For>
        </div>

        <div class="flex flex-col gap-2">
          <Show
            when={visibleRows().length > 0}
            fallback={
              <div class="rounded-xl bg-surface-inset-base/45 px-3.5 py-5 text-11-regular text-text-weak">
                {i18n._(S.rankNoData.id)}
              </div>
            }
          >
            <For each={visibleRows()}>
              {(row, index) => {
                const value = createMemo(() => row.values[activeMetric().id] ?? 0)
                const width = createMemo(() => (maxValue() > 0 ? Math.max(8, (value() / maxValue()) * 100) : 0))
                const secondaryMetrics = createMemo(() =>
                  metrics()
                    .filter((metric) => metric.id !== activeMetric().id && row.values[metric.id] !== undefined)
                    .slice(0, 2),
                )

                return (
                  <article
                    class="rounded-xl bg-surface-inset-base/45 px-3.5 py-3 ring-1 ring-inset ring-border-base/45"
                    style={{ animation: `rankListEnter 0.32s ease-out ${index() * 34}ms both` }}
                  >
                    <div class="flex items-start gap-3">
                      <div
                        class={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-10-semibold tabular-nums ring-1 ring-inset ${ACTIVE_METRIC_CLASSES}`}
                      >
                        {index() + 1}
                      </div>
                      <div class="min-w-0 flex-1">
                        <div class="flex items-start justify-between gap-3">
                          <div class="min-w-0">
                            <div class="truncate text-12-semibold text-text-strong">{row.label}</div>
                            <Show when={row.primary || row.secondary}>
                              <div class="mt-1 line-clamp-1 text-10-regular text-text-weak">
                                {[row.primary, row.secondary].filter(Boolean).join(" · ")}
                              </div>
                            </Show>
                          </div>
                          <div class="shrink-0 text-right">
                            <div class="text-12-semibold tabular-nums text-text-base">
                              {formatMetricValue(activeMetric(), value(), fmt.number, i18n)}
                            </div>
                            <div class="mt-1 text-[9px] uppercase tracking-[0.16em] text-text-weaker">
                              {metricLabel(activeMetric(), i18n)}
                            </div>
                          </div>
                        </div>

                        <div class="mt-3 h-1.5 rounded-full" style={{ background: metricSeries().rail }}>
                          <div
                            class="h-full rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${width()}%`, background: metricSeries().bar }}
                          />
                        </div>

                        <Show when={secondaryMetrics().length > 0}>
                          <div class="mt-3 flex flex-wrap gap-1.5">
                            <For each={secondaryMetrics()}>
                              {(metric) => (
                                <span class="rounded-full bg-surface-raised-stronger-non-alpha/70 px-2 py-1 text-[9px] font-medium tabular-nums text-text-weak ring-1 ring-inset ring-border-base/45">
                                  {metricLabel(metric, i18n)}{" "}
                                  {formatMetricValue(metric, row.values[metric.id] ?? 0, fmt.number, i18n, "compact")}
                                </span>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </div>
                  </article>
                )
              }}
            </For>
          </Show>
        </div>

        <Show when={hiddenCount() > 0}>
          <div class="mt-3 flex justify-center">
            <button
              type="button"
              class="rounded-full bg-surface-inset-base/65 px-3 py-1.5 text-10-medium text-text-weak ring-1 ring-inset ring-border-base/45 transition-colors hover:bg-surface-inset-base hover:text-text-base"
              onClick={() => setState("expanded", (expanded) => !expanded)}
            >
              {state.expanded
                ? i18n._(S.rankShowTop.id, { n: String(top()) })
                : i18n._(S.rankShowAll.id, { n: String(sortedRows().length) })}
            </button>
          </div>
        </Show>
      </section>
    </>
  )
}

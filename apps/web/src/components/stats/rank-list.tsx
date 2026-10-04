import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import type { RankingMetric, RankingRow } from "./model"
import { formatCompact, formatCost } from "./use-stats"
import { S } from "./stats-i18n"
import { AppPanel } from "../app-panel"
import "./stats.css"

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

const LEGACY_METRIC: RankingMetric = {
  id: "value",
  label: S.rankLegacyValue,
  unit: "",
  color: "indigo",
}

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
  raw: number | undefined,
  fmt: (n: number) => string,
  i18n: ReturnType<typeof useLocale>["i18n"],
  mode: "full" | "compact" = "full",
) {
  if (raw === undefined || !Number.isFinite(raw))
    return metric.unit === "usd" ? i18n._({ id: "stats.cost.unpriced", message: "Unpriced" }) : "—"
  const value = raw
  if (metric.unit === "usd") return formatCost(value)
  if (metric.unit === "%")
    return `${value >= 10 ? Math.round(value) : trimDecimal(value)}% ${mode === "full" ? metricLabel(metric, i18n).toLowerCase() : ""}`.trim()
  if (metric.unit === "ms") {
    if (value >= 1000) return i18n._(S.rankAvgSec.id, { value: trimDecimal(value / 1000) })
    return i18n._(S.rankAvgMs.id, { value: String(Math.round(value)) })
  }
  if (!metric.unit) return formatCount(value, fmt)
  return `${formatCount(value, fmt)} ${metricUnitLabel(metric, i18n)}`
}

function metricUnitLabel(metric: RankingMetric, i18n: ReturnType<typeof useLocale>["i18n"]) {
  if (metric.unit === "usd") return i18n._(S.rankMetricUSD.id)
  if (metric.unit === "%") return i18n._(S.rankMetricRate.id)
  if (metric.unit === "ms") return i18n._(S.rankMetricTime.id)
  if (metric.unit === "messages") return i18n._({ id: "stats.rank.unit.messages", message: "messages" })
  if (metric.unit === "calls") return i18n._({ id: "stats.rank.unit.calls", message: "calls" })
  if (metric.unit === "sessions") return i18n._({ id: "stats.rank.unit.sessions", message: "sessions" })
  if (metric.unit === "tokens") return i18n._({ id: "stats.rank.unit.tokens", message: "tokens" })
  return metric.unit
}

function sortedByMetric(rows: RankingRow[], metricID: string) {
  return [...rows].sort((a, b) => {
    if (a.values[metricID] === undefined && b.values[metricID] !== undefined) return 1
    if (b.values[metricID] === undefined && a.values[metricID] !== undefined) return -1
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
  const top = () => Math.max(1, normalized().defaultTop ?? 5)
  const metrics = () => normalized().metrics
  const activeMetric = () =>
    metrics().find((metric) => metric.id === state.activeMetricID) ?? metrics()[0] ?? LEGACY_METRIC
  const sortedRows = createMemo(() => sortedByMetric(normalized().rows, activeMetric().id))
  const visibleRows = () => (state.expanded ? sortedRows() : sortedRows().slice(0, top()))
  const hiddenCount = () => Math.max(0, sortedRows().length - top())
  const maxValue = () => Math.max(0, ...sortedRows().map((row) => row.values[activeMetric().id] ?? 0))
  const selectionItems = createMemo(() =>
    metrics().map((metric) => ({ id: metric.id, label: metricLabel(metric, i18n) })),
  )

  return (
    <section class="stats-rank-section">
      <div class="stats-rank-heading">
        <h3 class="app-panel-section-title text-text-strong">{normalized().title}</h3>
        <p class="app-panel-caption text-text-weak">{normalized().description}</p>
      </div>
      <AppPanel.Selection
        label={i18n._({
          id: "stats.rank.metricSelection",
          message: "{title} metric",
          values: { title: normalized().title },
        })}
        items={selectionItems()}
        active={activeMetric().id}
        onChange={(id) => setState({ activeMetricID: id, expanded: false })}
      />
      <div class="stats-rank-list">
        <Show
          when={visibleRows().length}
          fallback={<p class="app-panel-caption text-text-weak py-4">{i18n._(S.rankNoData.id)}</p>}
        >
          <For each={visibleRows()}>
            {(row, index) => {
              const value = () => row.values[activeMetric().id]
              const secondary = () =>
                metrics()
                  .filter((metric) => metric.id !== activeMetric().id && row.values[metric.id] !== undefined)
                  .slice(0, 2)
              return (
                <article class="stats-rank-row">
                  <span class="stats-rank-number app-panel-caption">{index() + 1}</span>
                  <div class="stats-rank-content">
                    <div class="stats-rank-main">
                      <span class="app-panel-row-title text-text-strong stats-rank-label" title={row.label}>
                        {row.label}
                      </span>
                      <span class="stats-rank-value app-panel-row-title">
                        {formatMetricValue(activeMetric(), value(), fmt.number, i18n)}
                      </span>
                    </div>
                    <Show when={row.primary || row.secondary}>
                      <p class="app-panel-caption text-text-weak">
                        {[row.primary, row.secondary].filter(Boolean).join(" · ")}
                      </p>
                    </Show>
                    <Show when={sortedRows().length > 1 && maxValue() > 0 && value() !== undefined}>
                      <div class="stats-rank-track" aria-hidden="true">
                        <div
                          class="stats-rank-bar"
                          style={{
                            width: `${Math.max(0, Math.min(100, ((value() ?? 0) / maxValue()) * 100))}%`,
                            background: METRIC_SERIES[activeMetric().color].bar,
                          }}
                        />
                      </div>
                    </Show>
                    <Show when={secondary().length}>
                      <div class="stats-rank-secondary app-panel-caption text-text-weak">
                        <For each={secondary()}>
                          {(metric) => (
                            <span>
                              <Show when={metric.unit === "usd" || metric.unit === "%"}>
                                {metricLabel(metric, i18n)}{" "}
                              </Show>
                              {formatMetricValue(metric, row.values[metric.id], fmt.number, i18n, "compact")}
                            </span>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </article>
              )
            }}
          </For>
        </Show>
      </div>
      <Show when={hiddenCount() > 0}>
        <button
          type="button"
          class="stats-rank-expand app-panel-control"
          aria-expanded={state.expanded}
          onClick={() => setState("expanded", (expanded) => !expanded)}
        >
          {state.expanded
            ? i18n._(S.rankShowTop.id, { n: String(top()) })
            : i18n._(S.rankShowAll.id, { n: String(sortedRows().length) })}
        </button>
      </Show>
    </section>
  )
}

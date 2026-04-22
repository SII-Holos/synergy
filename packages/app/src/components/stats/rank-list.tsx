import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { RankingMetric, RankingRow } from "./model"
import { formatCompact, formatCost } from "./use-stats"

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
  label: "Value",
  unit: "",
  color: "indigo",
}

const PALETTE = {
  indigo: {
    tab: "bg-indigo-500/14 text-indigo-200 ring-indigo-400/30",
    text: "text-indigo-200",
    badge: "bg-indigo-500/12 text-indigo-200 ring-indigo-400/20",
    rail: "rgba(99, 102, 241, 0.12)",
    bar: "linear-gradient(90deg, rgba(99,102,241,0.88), rgba(129,140,248,0.64))",
    glow: "0 0 0 1px rgba(129,140,248,0.12), inset 0 1px 0 rgba(255,255,255,0.04)",
  },
  emerald: {
    tab: "bg-emerald-500/14 text-emerald-200 ring-emerald-400/30",
    text: "text-emerald-200",
    badge: "bg-emerald-500/12 text-emerald-200 ring-emerald-400/20",
    rail: "rgba(16, 185, 129, 0.12)",
    bar: "linear-gradient(90deg, rgba(16,185,129,0.88), rgba(52,211,153,0.64))",
    glow: "0 0 0 1px rgba(52,211,153,0.12), inset 0 1px 0 rgba(255,255,255,0.04)",
  },
  amber: {
    tab: "bg-amber-500/14 text-amber-100 ring-amber-400/30",
    text: "text-amber-100",
    badge: "bg-amber-500/12 text-amber-100 ring-amber-400/20",
    rail: "rgba(245, 158, 11, 0.12)",
    bar: "linear-gradient(90deg, rgba(245,158,11,0.9), rgba(251,191,36,0.66))",
    glow: "0 0 0 1px rgba(251,191,36,0.12), inset 0 1px 0 rgba(255,255,255,0.04)",
  },
  rose: {
    tab: "bg-rose-500/14 text-rose-200 ring-rose-400/30",
    text: "text-rose-200",
    badge: "bg-rose-500/12 text-rose-200 ring-rose-400/20",
    rail: "rgba(244, 63, 94, 0.12)",
    bar: "linear-gradient(90deg, rgba(244,63,94,0.88), rgba(251,113,133,0.64))",
    glow: "0 0 0 1px rgba(251,113,133,0.12), inset 0 1px 0 rgba(255,255,255,0.04)",
  },
} satisfies Record<
  RankingMetric["color"],
  { tab: string; text: string; badge: string; rail: string; bar: string; glow: string }
>

function isNewProps(props: RankListProps): props is Extract<RankListProps, { rows: RankingRow[] }> {
  return "rows" in props
}

function normalizeProps(props: RankListProps) {
  if (isNewProps(props)) return props
  return {
    title: props.title,
    description: "Switch metrics to re-rank this list.",
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

function formatCount(value: number) {
  if (Math.abs(value) >= 100_000) return formatCompact(value)
  return Math.round(value).toLocaleString()
}

function formatMetricValue(metric: RankingMetric, raw: number, mode: "full" | "compact" = "full") {
  const value = Number.isFinite(raw) ? raw : 0
  if (metric.unit === "usd") return formatCost(value)
  if (metric.unit === "%")
    return `${value >= 10 ? Math.round(value) : trimDecimal(value)}% ${mode === "full" ? metric.label.toLowerCase() : ""}`.trim()
  if (metric.unit === "ms") {
    if (value >= 1000) return `${trimDecimal(value / 1000)}s avg`
    return `${Math.round(value)}ms avg`
  }
  if (!metric.unit) return formatCount(value)
  return `${formatCount(value)} ${metric.unit}`
}

function metricUnitLabel(metric: RankingMetric) {
  if (metric.unit === "usd") return "USD"
  if (metric.unit === "%") return "rate"
  if (metric.unit === "ms") return "time"
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
  const normalized = createMemo(() => normalizeProps(props))
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
  const palette = createMemo(() => PALETTE[activeMetric().color])
  const sortedRows = createMemo(() => sortedByMetric(normalized().rows, activeMetric().id))
  const visibleRows = createMemo(() => (state.expanded ? sortedRows() : sortedRows().slice(0, top())))
  const hiddenCount = createMemo(() => Math.max(0, sortedRows().length - top()))
  const maxValue = createMemo(() => Math.max(...sortedRows().map((row) => row.values[activeMetric().id] ?? 0), 0))
  const description = createMemo(() => {
    const text = normalized().description.trim()
    const sortHint = `Sorted by ${activeMetric().label.toLowerCase()}${metricUnitLabel(activeMetric()) ? ` · ${metricUnitLabel(activeMetric())}` : ""}`
    return text ? `${text} · ${sortHint}` : sortHint
  })

  return (
    <>
      <style>{ANIMATION_STYLE}</style>
      <section class="mt-5 rounded-[1.25rem] bg-surface-raised-base/95 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_0_-1px_0_rgba(255,255,255,0.03)]">
        <div class="flex items-start justify-between gap-4 px-1 pb-3">
          <div class="min-w-0">
            <div class="text-[9px] font-medium uppercase tracking-[0.18em] text-text-weaker">Ranking</div>
            <h3 class="mt-1 text-15-semibold text-text-strong tracking-tight">{normalized().title}</h3>
            <p class="mt-1 text-10-regular text-text-weak line-clamp-2">{description()}</p>
          </div>
          <div
            class={`hidden rounded-full px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.16em] ring-1 ring-inset md:block ${palette().tab}`}
          >
            {activeMetric().label}
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
                      ? `${PALETTE[metric.color].tab} shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]`
                      : "bg-surface-inset-base/65 text-text-weak ring-white/6 hover:bg-surface-inset-base hover:text-text-base"
                  }`}
                  onClick={() => setState({ activeMetricID: metric.id, expanded: false })}
                >
                  <span>{metric.label}</span>
                  <span class="ml-1.5 text-[9px] uppercase tracking-[0.12em] opacity-70">
                    {metric.unit || "metric"}
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
                No ranking data yet.
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
                    class="rounded-xl bg-surface-inset-base/45 px-3.5 py-3 ring-1 ring-inset ring-white/6"
                    style={{
                      animation: `rankListEnter 0.32s ease-out ${index() * 34}ms both`,
                      "box-shadow": palette().glow,
                    }}
                  >
                    <div class="flex items-start gap-3">
                      <div
                        class={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-10-semibold tabular-nums ring-1 ring-inset ${palette().badge}`}
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
                            <div class={`text-12-semibold tabular-nums ${palette().text}`}>
                              {formatMetricValue(activeMetric(), value())}
                            </div>
                            <div class="mt-1 text-[9px] uppercase tracking-[0.16em] text-text-weaker">
                              {activeMetric().label}
                            </div>
                          </div>
                        </div>

                        <div class="mt-3 h-1.5 rounded-full" style={{ background: palette().rail }}>
                          <div
                            class="h-full rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${width()}%`, background: palette().bar }}
                          />
                        </div>

                        <Show when={secondaryMetrics().length > 0}>
                          <div class="mt-3 flex flex-wrap gap-1.5">
                            <For each={secondaryMetrics()}>
                              {(metric) => (
                                <span class="rounded-full bg-black/10 px-2 py-1 text-[9px] font-medium tabular-nums text-text-weak ring-1 ring-inset ring-white/6">
                                  {metric.label} {formatMetricValue(metric, row.values[metric.id] ?? 0, "compact")}
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
              class="rounded-full bg-surface-inset-base/65 px-3 py-1.5 text-10-medium text-text-weak ring-1 ring-inset ring-white/6 transition-colors hover:bg-surface-inset-base hover:text-text-base"
              onClick={() => setState("expanded", (expanded) => !expanded)}
            >
              {state.expanded ? `Show top ${top()}` : `Show all ${sortedRows().length}`}
            </button>
          </div>
        </Show>
      </section>
    </>
  )
}

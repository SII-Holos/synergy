import { createMemo, createSignal, For } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import { ContextRing } from "./context-ring"
import { CostBreakdown } from "./cost-breakdown"
import { UsagePopover } from "./usage"
import { executionCostText } from "./cost"
import { tokenMetricText } from "./task-details-model"
import { D } from "./context-categories"
import { E } from "./i18n"

export function ContextUsageStats(props: { summary: ExecutionSummary; now: number }) {
  const { _, i18n } = useLingui()
  const [highlight, setHighlight] = createSignal("")
  const tokens = () => props.summary.accounting.tokens
  const number = (value: number) =>
    new Intl.NumberFormat(i18n().locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
  const rows = createMemo(() => {
    const output = tokens().output.total
    const reasoning = tokens().reasoning.total
    const separate = output != null && reasoning != null && output >= reasoning
    return [
      { key: "uncached", label: _(E.uncached), metric: tokens().uncached, color: "var(--chart-series-1)" },
      { key: "cacheRead", label: _(E.cacheRead), metric: tokens().cacheRead, color: "var(--chart-series-3)" },
      { key: "cacheWrite", label: _(E.cacheWrite), metric: tokens().cacheWrite, color: "var(--chart-series-5)" },
      {
        key: "output",
        label: _(separate ? D.answerTokens : E.output),
        metric: separate ? { known: output - reasoning, total: output - reasoning, unknown: 0 } : tokens().output,
        color: "var(--chart-series-6)",
      },
      ...(separate
        ? [{ key: "reasoning", label: _(D.reasoning), metric: tokens().reasoning, color: "var(--chart-series-4)" }]
        : []),
    ]
  })
  const complete = () =>
    rows().every((row) => row.metric.total != null) &&
    rows().reduce((sum, row) => sum + row.metric.total!, 0) === tokens().total.total
  const segments = () =>
    complete() ? rows().map((row) => ({ key: row.key, value: row.metric.total!, color: row.color })) : []
  return (
    <section class="context-usage-stats" aria-label={_(D.tokenStats)}>
      <div class="context-section-heading">
        <h3>{_(D.tokenStats)}</h3>
        <UsagePopover summary={props.summary} class="context-link">
          {_(D.usageDetails)}
        </UsagePopover>
      </div>
      <div class="context-usage-body">
        <ContextRing
          segments={segments()}
          total={tokens().total.total}
          label={_(D.accumulated)}
          value={
            (tokens().total.unknown ? "≥ " : "") +
            (props.summary.accounting.calls || tokens().total.known ? number(tokens().total.known) : "—")
          }
          caption={_(D.accumulated)}
          highlight={highlight()}
          onHighlight={setHighlight}
        />
        <div class="context-usage-legend">
          <For each={rows()}>
            {(row) => (
              <div
                onMouseEnter={() => setHighlight(row.key)}
                onMouseLeave={() => setHighlight("")}
                onFocusIn={() => setHighlight(row.key)}
                onFocusOut={() => setHighlight("")}
              >
                <UsagePopover summary={props.summary} label={row.label} class="context-usage-value">
                  <span class="context-dot" style={{ background: row.color }} />
                  <span>{row.label}</span>
                  <strong title={tokenMetricText(row.metric, i18n().locale)}>
                    {row.metric.total == null ? tokenMetricText(row.metric, i18n().locale) : number(row.metric.total)}
                  </strong>
                </UsagePopover>
              </div>
            )}
          </For>
        </div>
      </div>
      <ContextMetrics summary={props.summary} now={props.now} />
    </section>
  )
}

function ContextMetrics(props: { summary: ExecutionSummary; now: number }) {
  const { _, i18n } = useLingui()
  const cache = () => props.summary.cache.ratio ?? props.summary.cache.observedRatio
  return (
    <div class="context-metrics">
      <Popover
        title={_(E.cost)}
        triggerAs={(trigger) => (
          <button {...trigger} class="context-metric">
            <span>{_(E.cost)}</span>
            <strong>{executionCostText(props.summary.cost, i18n().locale)}</strong>
          </button>
        )}
      >
        <CostBreakdown cost={props.summary.cost} />
      </Popover>
      <UsagePopover summary={props.summary} label={_(E.elapsed)} class="context-metric">
        <span>{_(E.elapsed)}</span>
        <strong>
          {props.summary.elapsedMs == null
            ? "—"
            : executionDuration(
                props.summary.elapsedMs + (props.summary.elapsedActive ? props.now : 0),
                props.summary.elapsedLowerBound,
              )}
        </strong>
      </UsagePopover>
      <UsagePopover summary={props.summary} label={_(E.cacheHit)} class="context-metric">
        <span>{_(props.summary.cache.ratio == null ? E.observedCacheHit : E.cacheHit)}</span>
        <strong>
          {cache() == null
            ? "—"
            : new Intl.NumberFormat(i18n().locale, { style: "percent", maximumFractionDigits: 1 }).format(cache()!)}
        </strong>
      </UsagePopover>
    </div>
  )
}

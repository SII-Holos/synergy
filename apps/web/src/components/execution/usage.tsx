import { For, Show, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { tokenMetricText } from "./task-details-model"
import { E } from "./i18n"

export function ExecutionPerformance(props: { summary: ExecutionSummary }) {
  const { _, i18n } = useLingui()
  const rate = () => props.summary.rates.generation
  const cache = () => props.summary.cache
  const ratio = () => cache().ratio ?? cache().observedRatio
  const observed = () => cache().ratio == null
  const rateText = () =>
    _({
      ...E.tokenRate,
      values: { value: new Intl.NumberFormat(i18n().locale, { maximumFractionDigits: 1 }).format(rate().value!) },
    })
  const cacheText = () =>
    new Intl.NumberFormat(i18n().locale, { style: "percent", maximumFractionDigits: 1 }).format(ratio()!)
  return (
    <Show when={rate().value != null || ratio() != null}>
      <dl class="execution-performance">
        <Show when={rate().value != null}>
          <div>
            <dt>{_(E.generationRate)}</dt>
            <dd>{rateText()}</dd>
          </div>
        </Show>
        <Show when={ratio() != null}>
          <div>
            <dt>{_(observed() ? E.observedCacheHit : E.cacheHit)}</dt>
            <dd>{cacheText()}</dd>
          </div>
        </Show>
      </dl>
    </Show>
  )
}

export function UsagePopover(props: {
  summary: ExecutionSummary
  label?: string
  class?: string
  children: JSX.Element
}) {
  const { _ } = useLingui()
  return (
    <Popover
      title={_(E.usageDetails)}
      class="execution-usage-popover"
      placement="bottom-end"
      triggerAs={(trigger) => (
        <button {...trigger} type="button" class={props.class} aria-label={props.label ?? _(E.usageDetails)}>
          {props.children}
        </button>
      )}
    >
      <UsageBreakdown summary={props.summary} />
    </Popover>
  )
}

function UsageBreakdown(props: { summary: ExecutionSummary }) {
  const { _, i18n } = useLingui()
  const number = (value: number) => new Intl.NumberFormat(i18n().locale, { maximumFractionDigits: 2 }).format(value)
  const tokens = () => props.summary.accounting.tokens
  const seconds = (value: number | null) =>
    value == null ? "—" : _({ ...E.seconds, values: { value: number(value / 1000) } })
  const rows = () => [
    { label: _(E.tokens), metric: tokens().total },
    { label: _(E.input), metric: tokens().input },
    { label: _(E.uncached), metric: tokens().uncached, nested: true },
    { label: _(E.cacheRead), metric: tokens().cacheRead, nested: true },
    { label: _(E.cacheWrite), metric: tokens().cacheWrite, nested: true },
    { label: _(E.output), metric: tokens().output },
    { label: _(E.reasoningTokens), metric: tokens().reasoning, nested: true },
  ]
  const toolTotals = () =>
    props.summary.tools.reduce(
      (total, tool) => ({
        calls: total.calls + tool.calls,
        samples: total.samples + tool.timedSamples,
        milliseconds: total.milliseconds + tool.durationMs,
      }),
      { calls: 0, samples: 0, milliseconds: 0 },
    )
  return (
    <div class="execution-usage-details">
      <dl class="execution-detail-rows execution-usage-rows">
        <For each={rows()}>
          {(row) => (
            <div data-nested={row.nested}>
              <dt>{row.label}</dt>
              <dd>{tokenMetricText(row.metric, i18n().locale)}</dd>
            </div>
          )}
        </For>
      </dl>
      <dl class="execution-detail-rows execution-usage-rows execution-usage-section">
        <div>
          <dt>{_(E.own)}</dt>
          <dd>{tokenMetricText(props.summary.own.tokens.total, i18n().locale)}</dd>
        </div>
        <div>
          <dt>{_(E.children)}</dt>
          <dd>{tokenMetricText(props.summary.descendants.tokens.total, i18n().locale)}</dd>
        </div>
      </dl>
      <section class="execution-usage-section" aria-label={_(E.requestMetrics)}>
        <h3>{_(E.requestMetrics)}</h3>
        <dl class="execution-detail-rows execution-usage-rows">
          <div>
            <dt>{_(E.calls)}</dt>
            <dd>{number(props.summary.accounting.calls)}</dd>
          </div>
          <div>
            <dt>{_(E.requests)}</dt>
            <dd>{number(props.summary.accounting.attempts)}</dd>
          </div>
          <div>
            <dt>{_(E.retryCount)}</dt>
            <dd>{number(props.summary.outcomes.retries)}</dd>
          </div>
          <div>
            <dt>{_(E.firstContent)}</dt>
            <dd>{seconds(props.summary.latency.ttft.meanMs)}</dd>
          </div>
          <div>
            <dt>{_(E.requestDuration)}</dt>
            <dd>{seconds(props.summary.latency.request.meanMs)}</dd>
          </div>
          <div>
            <dt>{_(E.requestRate)}</dt>
            <dd>
              {props.summary.rates.endToEnd.value == null
                ? "—"
                : _({ ...E.tokenRate, values: { value: number(props.summary.rates.endToEnd.value!) } })}
            </dd>
          </div>
          <div>
            <dt>{_(E.toolCalls)}</dt>
            <dd>{number(toolTotals().calls)}</dd>
          </div>
          <div>
            <dt>{_(E.toolDuration)}</dt>
            <dd>
              {toolTotals().samples
                ? (toolTotals().samples < toolTotals().calls ? "≥ " : "") + seconds(toolTotals().milliseconds)
                : "—"}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  )
}

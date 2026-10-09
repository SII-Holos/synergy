import { executionDuration } from "@ericsanchezok/synergy-ui/execution-completion"
import { createMemo, createSignal, For } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { ExecutionSummary } from "@ericsanchezok/synergy-sdk/client"
import { D } from "./context-categories"
import { E } from "./i18n"
import { ContextRing } from "./context-ring"

export function ContextTiming(props: { summary: ExecutionSummary }) {
  const { _, i18n } = useLingui()
  const [highlight, setHighlight] = createSignal("")
  const phases = createMemo(() => [
    {
      key: "modelWait" as const,
      milliseconds: props.summary.latency.ttft.totalMs,
      count: props.summary.latency.ttft.samples,
      color: "var(--chart-series-1)",
    },
    {
      key: "generation" as const,
      milliseconds: props.summary.latency.generation.totalMs,
      count: props.summary.latency.generation.samples,
      color: "var(--chart-series-4)",
    },
    {
      key: "toolExecution" as const,
      milliseconds: props.summary.tools.reduce((sum, tool) => sum + tool.durationMs, 0),
      count: props.summary.tools.reduce((sum, tool) => sum + tool.timedSamples, 0),
      color: "var(--chart-series-7)",
    },
  ])
  const total = () => phases().reduce((sum, phase) => sum + phase.milliseconds, 0)
  const number = (value: number) => new Intl.NumberFormat(i18n().locale, { maximumFractionDigits: 1 }).format(value)
  const duration = (value: number) => _({ ...E.seconds, values: { value: number(value / 1000) } })
  return (
    <section class="context-timing" aria-label={_(D.timing)}>
      <div class="context-section-heading">
        <h3>{_(D.timing)}</h3>
        <span class="context-timing-rate">
          {_(E.generationRate)}{" "}
          <strong>
            {props.summary.rates.generation.value == null
              ? "—"
              : _({ ...E.tokenRate, values: { value: number(props.summary.rates.generation.value) } })}
          </strong>
        </span>
      </div>
      <div class="context-timing-body">
        <ContextRing
          segments={phases().map((phase) => ({ key: phase.key, value: phase.milliseconds, color: phase.color }))}
          total={total()}
          label={_(D.timingTotal)}
          value={total() ? executionDuration(total(), false) : "—"}
          caption={_(D.timingTotal)}
          highlight={highlight()}
          onHighlight={setHighlight}
        />
        <dl class="context-timing-legend">
          <For each={phases()}>
            {(phase) => (
              <div onMouseEnter={() => setHighlight(phase.key)} onMouseLeave={() => setHighlight("")}>
                <dt>
                  <span class="context-dot" style={{ background: phase.color }} />
                  {_(D[phase.key])}
                </dt>
                <dd>
                  <strong>{phase.count ? duration(phase.milliseconds) : "—"}</strong>
                  <small>{_({ ...D.timedCalls, values: { count: phase.count } })}</small>
                </dd>
              </div>
            )}
          </For>
        </dl>
      </div>
      <div
        class="context-timing-strip"
        role="img"
        aria-label={_(D.timingTotal) + ": " + (total() ? executionDuration(total(), false) : "—")}
      >
        <For each={phases()}>
          {(phase) => (
            <span
              style={{ width: (total() ? (phase.milliseconds / total()) * 100 : 0) + "%", background: phase.color }}
            />
          )}
        </For>
      </div>
      <div class="context-timing-footer">
        <span>{_(D.timingBasis)}</span>
        <span>
          {_({ ...D.requestCount, values: { count: props.summary.accounting.attempts } })} ·{" "}
          {_({ ...D.retryCount, values: { count: props.summary.outcomes.retries } })}
        </span>
      </div>
    </section>
  )
}
